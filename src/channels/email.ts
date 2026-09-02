import { ImapFlow, type FetchMessageObject } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser, type ParsedMail } from "mailparser";
import pino from "pino";
import type { AppConfig } from "../config.js";
import type { AgentRegistry } from "../core/agents.js";
import { isAllowedAddress } from "../core/allowlist.js";
import { runConversationTurn } from "../core/conversationTurn.js";
import { htmlToTextLoose, firstLineSummary, parseAgentFromSubject } from "../core/text.js";
import { parseLatestMbCtx, formatMbCtxFooter } from "../core/mbctx.js";
import type { ConversationStore } from "../conversation/store.js";
import type { ProcessedStore } from "../conversation/processedStore.js";
import type { MemoryEngine } from "../memory/memoryEngine.js";

/** Set on every outgoing reply so the poller recognises (and skips) its own mail. */
export const OUTBOUND_HEADER = "X-EveryBot-Out";
export const CONV_HEADER = "X-EveryBot-Conv";
/** Name used by earlier releases; still honoured so an upgrade never re-answers old replies. */
const LEGACY_OUTBOUND_HEADER = "x-moltbot-out";

/** After this many failed attempts a message is marked processed and left alone. */
const MAX_FAILURES_PER_MESSAGE = 3;

/** Strip CR and LF so user-controlled text can never inject extra mail headers. */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

type Inbound = {
  uid: number;
  messageId: string | null;
  subject: string | null;
  from: string | null;
  text: string;
  rawTextForCtxScan: string;
  inReplyTo: string | null;
  references: string[] | null;
  hasBotHeader: boolean;
};

type GeneratedReply = { convId: string; agentId: string; msgNo: number; replyText: string };

/** The subset of ImapFlow this channel needs; injectable so the channel is testable without a mailbox. */
export interface ImapClientLike {
  readonly usable: boolean;
  connect(): Promise<void>;
  logout(): Promise<void>;
  mailboxOpen(path: string): Promise<unknown>;
  search(query: { seen: boolean }, options: { uid: true }): Promise<number[] | false>;
  fetchOne(
    uid: string,
    query: { source?: boolean; envelope?: boolean },
    options: { uid: true }
  ): Promise<FetchMessageObject | false>;
  messageFlagsAdd(uid: string, flags: string[], options: { uid: true }): Promise<boolean>;
}

export interface MailTransportLike {
  sendMail(options: {
    from: string;
    to: string;
    subject: string;
    text: string;
    headers?: Record<string, string>;
    inReplyTo?: string;
    references?: string[];
  }): Promise<unknown>;
}

export type ChannelLogger = {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
};

export type EmailChannelOptions = {
  createImap?: () => ImapClientLike;
  smtpTransport?: MailTransportLike;
  logger?: ChannelLogger;
};

/**
 * Turns a mailbox into a chat channel: unread mail from allow-listed senders is handed to
 * an agent and the reply is mailed back with an MBCTX footer that lets the next mail in
 * the thread continue the same conversation.
 */
export class EmailChannel {
  private readonly log: ChannelLogger;
  private readonly createImap: () => ImapClientLike;
  private readonly smtp: MailTransportLike;
  private imap: ImapClientLike | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private polling = false;
  /** UIDs from senders that are not allow-listed; remembered so they are not re-fetched every poll. */
  private readonly ignoredUids = new Set<number>();
  private readonly failures = new Map<string, number>();

  constructor(
    private cfg: AppConfig,
    private agents: AgentRegistry,
    private convStore: ConversationStore,
    private processed: ProcessedStore,
    private memoryEngine: MemoryEngine | null = null,
    options: EmailChannelOptions = {}
  ) {
    this.log = options.logger ?? pino({ name: "EmailChannel" });
    this.createImap =
      options.createImap ??
      (() =>
        new ImapFlow({
          host: cfg.mail.imap.host,
          port: cfg.mail.imap.port,
          secure: cfg.mail.imap.secure,
          auth: { user: cfg.mail.user, pass: cfg.mail.pass },
          logger: false,
        }));
    this.smtp =
      options.smtpTransport ??
      nodemailer.createTransport({
        host: cfg.mail.smtp.host,
        port: cfg.mail.smtp.port,
        secure: cfg.mail.smtp.secure,
        auth: { user: cfg.mail.user, pass: cfg.mail.pass },
      });
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (!this.cfg.mail.user || !this.cfg.mail.pass) {
      this.log.info("Mail credentials not set; EmailChannel disabled");
      return;
    }
    if (this.cfg.mail.allowedSenders.length === 0) {
      this.log.warn("MAIL_ALLOWED_SENDERS is not set; only mail sent from MAIL_USER itself will be answered");
    }
    await this.processed.load();
    await this.connect();
    this.running = true;
    this.log.info("EmailChannel started; polling INBOX");

    await this.pollOnceSafe();
    this.timer = setInterval(() => void this.pollOnceSafe(), this.cfg.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.disconnect();
  }

  private async connect(): Promise<ImapClientLike> {
    const client = this.createImap();
    await client.connect();
    await client.mailboxOpen("INBOX");
    this.imap = client;
    return client;
  }

  private async disconnect(): Promise<void> {
    const client = this.imap;
    this.imap = null;
    if (!client) return;
    try {
      await client.logout();
    } catch {
      // the connection may already be gone
    }
  }

  /** IMAP servers drop idle connections; reconnect transparently instead of failing every poll forever. */
  private async ensureConnected(): Promise<ImapClientLike> {
    if (this.imap?.usable) return this.imap;
    if (this.imap) {
      this.log.warn("IMAP connection is no longer usable; reconnecting");
      await this.disconnect();
    }
    return this.connect();
  }

  /** One poll. Overlapping ticks are skipped, so a slow LLM can never produce duplicate replies. */
  async pollOnceSafe(): Promise<void> {
    if (!this.running || this.polling) return;
    this.polling = true;
    try {
      await this.pollOnce();
    } catch (e: unknown) {
      this.log.error({ err: e instanceof Error ? e.message : String(e) }, "pollOnce failed");
    } finally {
      this.polling = false;
    }
  }

  private async markSeen(imap: ImapClientLike, uid: number): Promise<void> {
    await imap.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
  }

  private async pollOnce(): Promise<void> {
    const imap = await this.ensureConnected();
    const uids = await imap.search({ seen: false }, { uid: true });
    if (!uids || uids.length === 0) return;

    const fresh = uids.filter((uid) => !this.ignoredUids.has(uid));
    if (fresh.length === 0) return;
    this.log.info({ count: fresh.length }, "Found unseen emails");

    for (const uid of fresh) {
      if (!this.running) return;

      // Envelope first: cheap, and enough to drop mail from unknown senders without downloading it.
      const head = await imap.fetchOne(String(uid), { envelope: true }, { uid: true });
      if (!head) continue;
      const sender = head.envelope?.from?.[0]?.address ?? null;
      if (!isAllowedAddress(sender, this.cfg.mail.allowedSenders, this.cfg.mail.user)) {
        this.log.info({ uid, from: sender }, "Ignoring mail from a sender that is not allow-listed");
        // Left unread on purpose: it is the user's mail, not ours to touch.
        this.ignoredUids.add(uid);
        continue;
      }

      const msg = await imap.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) continue;

      const inbound = this.toInbound(uid, await simpleParser(msg.source));
      const dedupeKey = inbound.messageId ? `mid:${inbound.messageId}` : `uid:${uid}`;

      if (this.processed.has(dedupeKey)) {
        await this.markSeen(imap, uid);
        continue;
      }
      if (inbound.hasBotHeader || !inbound.from) {
        await this.processed.add(dedupeKey);
        await this.markSeen(imap, uid);
        continue;
      }

      await this.handleInbound(imap, inbound, dedupeKey);
    }
  }

  private toInbound(uid: number, parsed: ParsedMail): Inbound {
    const botHeader = parsed.headers.get(OUTBOUND_HEADER.toLowerCase()) ?? parsed.headers.get(LEGACY_OUTBOUND_HEADER);
    const hasBotHeader = botHeader ? ["1", "true", "yes"].includes(String(botHeader).trim().toLowerCase()) : false;

    const textPart = (parsed.text ?? "").trim();
    const htmlPart = typeof parsed.html === "string" ? htmlToTextLoose(parsed.html) : "";
    const references = Array.isArray(parsed.references)
      ? parsed.references
      : typeof parsed.references === "string"
        ? [parsed.references]
        : null;

    return {
      uid,
      messageId: parsed.messageId ?? null,
      subject: parsed.subject ?? null,
      from: parsed.from?.value?.[0]?.address ?? null,
      text: (textPart || htmlPart || "").trim(),
      rawTextForCtxScan: [textPart, htmlPart].filter(Boolean).join("\n\n"),
      inReplyTo: parsed.inReplyTo ?? null,
      references,
      hasBotHeader,
    };
  }

  /**
   * Generate, persist and send a reply. The message counts as processed as soon as the
   * reply is stored: an SMTP failure is logged, never retried with a second LLM call.
   * An LLM failure is retried on later polls, up to MAX_FAILURES_PER_MESSAGE.
   */
  private async handleInbound(imap: ImapClientLike, inb: Inbound, dedupeKey: string): Promise<void> {
    let reply: GeneratedReply;
    try {
      reply = await this.generateReply(inb);
    } catch (e) {
      const attempts = (this.failures.get(dedupeKey) ?? 0) + 1;
      this.failures.set(dedupeKey, attempts);
      this.log.error({ err: e instanceof Error ? e.message : String(e), attempts }, "Failed to answer inbound mail");
      if (attempts >= MAX_FAILURES_PER_MESSAGE) {
        this.log.warn({ dedupeKey }, "Giving up on this message after repeated failures");
        this.failures.delete(dedupeKey);
        await this.processed.add(dedupeKey);
        await this.markSeen(imap, uidOf(inb));
      }
      return;
    }

    this.failures.delete(dedupeKey);
    await this.processed.add(dedupeKey);
    await this.markSeen(imap, uidOf(inb));

    try {
      await this.sendReply(inb, reply);
      this.log.info({ convId: reply.convId, msgNo: reply.msgNo, agentId: reply.agentId }, "Replied");
    } catch (e) {
      this.log.error(
        { err: e instanceof Error ? e.message : String(e), convId: reply.convId, msgNo: reply.msgNo },
        "Reply was generated and stored, but the SMTP send failed"
      );
    }
  }

  private async generateReply(inb: Inbound): Promise<GeneratedReply> {
    const { defaultAgent } = this.cfg;
    const subjectAgent = parseAgentFromSubject(inb.subject);
    const ctx = parseLatestMbCtx(inb.rawTextForCtxScan);

    const meta = ctx?.convId
      ? await this.convStore.ensureConversation(ctx.convId, defaultAgent)
      : await this.convStore.createConversation(defaultAgent);

    // Precedence: a known "@agent" in the subject, then the conversation's own agent,
    // then the agent named in the quoted MBCTX footer, then the default.
    let agentId = defaultAgent;
    if (subjectAgent && this.agents.has(subjectAgent)) {
      agentId = subjectAgent;
    } else if (this.agents.has(meta.agentId)) {
      agentId = meta.agentId;
    } else if (ctx?.agentId && this.agents.has(ctx.agentId)) {
      agentId = ctx.agentId;
    }
    if (subjectAgent && !this.agents.has(subjectAgent)) {
      this.log.warn({ subjectAgent, using: agentId }, "Unknown agent in subject; keeping the conversation's agent");
    }
    if (agentId !== meta.agentId) {
      meta.agentId = agentId;
      await this.convStore.saveMeta(meta);
    }

    const { replyText, msgNo } = await runConversationTurn(
      { convStore: this.convStore, agents: this.agents, memoryEngine: this.memoryEngine },
      meta,
      agentId,
      inb.text,
      { emailId: inb.messageId ?? undefined }
    );
    return { convId: meta.convId, agentId, msgNo, replyText };
  }

  private async sendReply(inb: Inbound, reply: GeneratedReply): Promise<void> {
    const summary = firstLineSummary(inb.text || "reply");
    const footer = formatMbCtxFooter({ convId: reply.convId, msgNo: reply.msgNo, agentId: reply.agentId });

    await this.smtp.sendMail({
      from: this.cfg.mail.user,
      // The sender passed the allow-list, so the reply goes back to them (usually the owner).
      to: inb.from ?? this.cfg.mail.user,
      subject: sanitizeHeaderValue(`#${reply.msgNo} [${reply.agentId}] ${summary}`),
      text: `${reply.replyText}\n\n${footer}`,
      inReplyTo: inb.messageId ? sanitizeHeaderValue(inb.messageId) : undefined,
      references: inb.references?.length ? inb.references.map(sanitizeHeaderValue) : undefined,
      headers: { [OUTBOUND_HEADER]: "1", [CONV_HEADER]: reply.convId },
    });
  }
}

function uidOf(inb: Inbound): number {
  return inb.uid;
}

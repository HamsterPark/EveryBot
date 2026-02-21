import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import pino from "pino";
import type { AppConfig } from "../config.js";
import type { AgentRegistry } from "../core/agents.js";
import type { MemoryPack } from "../core/agents.js";
import { htmlToTextLoose, firstLineSummary, parseAgentFromSubject } from "../core/text.js";
import { parseLatestMbCtx, formatMbCtxFooter } from "../core/mbctx.js";
import { ConversationStore } from "../conversation/store.js";
import { ProcessedStore } from "../conversation/processedStore.js";
import type { MemoryEngine } from "../memory/memoryEngine.js";

type Inbound = {
  messageId: string | null;
  subject: string | null;
  from: string | null;
  text: string;
  rawTextForCtxScan: string;
  inReplyTo?: string | null;
  references?: string[] | null;
  hasBotHeader: boolean;
};

export class EmailChannel {
  private log = pino({ name: "EmailChannel" });
  private imap: ImapFlow;
  private smtpTransport: nodemailer.Transporter;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private cfg: AppConfig,
    private agents: AgentRegistry,
    private convStore: ConversationStore,
    private processed: ProcessedStore,
    private memoryEngine: MemoryEngine | null = null
  ) {
    this.imap = new ImapFlow({
      host: cfg.mail.imap.host,
      port: cfg.mail.imap.port,
      secure: cfg.mail.imap.secure,
      auth: { user: cfg.mail.user, pass: cfg.mail.pass },
      logger: false,
    });

    this.smtpTransport = nodemailer.createTransport({
      host: cfg.mail.smtp.host,
      port: cfg.mail.smtp.port,
      secure: cfg.mail.smtp.secure,
      auth: { user: cfg.mail.user, pass: cfg.mail.pass },
    });
  }

  async start(): Promise<void> {
    if (!this.cfg.mail.user || !this.cfg.mail.pass) {
      this.log.info("Mail credentials not set; EmailChannel disabled");
      return;
    }
    await this.processed.load();
    await this.imap.connect();
    await this.imap.mailboxOpen("INBOX");
    this.running = true;

    this.log.info("EmailChannel started; polling INBOX");

    await this.pollOnceSafe();
    this.timer = setInterval(() => void this.pollOnceSafe(), this.cfg.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      await this.imap.logout();
    } catch {
      // ignore
    }
  }

  private async pollOnceSafe(): Promise<void> {
    if (!this.running) return;
    try {
      await this.pollOnce();
    } catch (e: unknown) {
      this.log.error({ err: e instanceof Error ? e.message : String(e) }, "pollOnce failed");
    }
  }

  private async pollOnce(): Promise<void> {
    const uids = await this.imap.search({ seen: false });
    if (!uids.length) return;

    this.log.info({ count: uids.length }, "Found unseen emails");

    for (const uid of uids) {
      const msg = await this.imap.fetchOne(uid, { source: true, envelope: true });
      if (!msg?.source) continue;

      const parsed = await simpleParser(msg.source as Buffer);
      const inbound = this.toInbound(parsed);

      const dedupeKey = inbound.messageId ? `mid:${inbound.messageId}` : `uid:${uid}`;
      if (this.processed.has(dedupeKey)) {
        await this.imap.messageFlagsAdd(uid, ["\\Seen"]);
        continue;
      }

      if (inbound.hasBotHeader) {
        await this.processed.add(dedupeKey);
        await this.imap.messageFlagsAdd(uid, ["\\Seen"]);
        continue;
      }

      if (!inbound.from) {
        await this.processed.add(dedupeKey);
        await this.imap.messageFlagsAdd(uid, ["\\Seen"]);
        continue;
      }

      await this.handleInbound(inbound);

      await this.processed.add(dedupeKey);
      await this.imap.messageFlagsAdd(uid, ["\\Seen"]);
    }
  }

  private toInbound(parsed: { headers?: Map<string, unknown>; from?: { value?: Array<{ address?: string }> }; subject?: string; text?: string; html?: string; messageId?: string; inReplyTo?: string; references?: unknown }): Inbound {
    const headers = parsed.headers;
    const hasBotHeader = (() => {
      const v = headers?.get("x-moltbot-out");
      if (!v) return false;
      const s = String(v).trim().toLowerCase();
      return s === "1" || s === "true" || s === "yes";
    })();

    const fromAddr = parsed.from?.value?.[0]?.address ? String(parsed.from.value[0].address) : null;
    const subject = parsed.subject ? String(parsed.subject) : null;

    const textPart = (parsed.text ? String(parsed.text) : "").trim();
    const htmlPart = parsed.html ? htmlToTextLoose(String(parsed.html)) : "";
    const rawTextForCtxScan = [textPart, htmlPart].filter(Boolean).join("\n\n");
    const userText = (textPart || htmlPart || "").trim();

    return {
      messageId: parsed.messageId ? String(parsed.messageId) : null,
      subject,
      from: fromAddr,
      text: userText,
      rawTextForCtxScan,
      inReplyTo: parsed.inReplyTo ? String(parsed.inReplyTo) : null,
      references: Array.isArray(parsed.references) ? parsed.references.map(String) : null,
      hasBotHeader,
    };
  }

  private async handleInbound(inb: Inbound): Promise<void> {
    const { defaultAgent } = this.cfg;

    const subjectAgent = parseAgentFromSubject(inb.subject);
    const ctxFromBody = parseLatestMbCtx(inb.rawTextForCtxScan);

    const convId = ctxFromBody?.convId ?? null;
    const agentFromCtx = ctxFromBody?.agentId ?? null;

    const meta = convId
      ? await this.convStore.ensureConversation(convId, defaultAgent)
      : await this.convStore.createConversation(defaultAgent);

    let agentId = subjectAgent ?? agentFromCtx ?? meta.agentId ?? defaultAgent;
    if (!this.agents.has(agentId)) agentId = defaultAgent;

    if (subjectAgent && subjectAgent !== meta.agentId) {
      meta.agentId = agentId;
      await this.convStore.saveMeta(meta);
    }

    await this.convStore.append(meta.convId, {
      role: "user",
      text: inb.text,
      at: new Date().toISOString(),
      emailId: inb.messageId ?? undefined,
    });

    const memory: MemoryPack = this.memoryEngine
      ? await this.memoryEngine.buildMemoryPack(meta.convId)
      : { summary: "", facts: {}, recentTurns: (await this.convStore.getThread(meta.convId)).map((t) => ({ role: t.role, text: t.text })) };

    const agent = this.agents.get(agentId);
    const replyText = await agent.handle(inb.text, { convId: meta.convId, agentId }, memory);

    const msgNo = await this.convStore.nextBotMsgNo(meta.convId);
    await this.convStore.append(meta.convId, {
      role: "bot",
      text: replyText,
      at: new Date().toISOString(),
      msgNo,
      agentId,
    });

    if (this.memoryEngine) {
      await this.memoryEngine.afterReply(meta.convId, [
        { role: "user", text: inb.text, at: new Date().toISOString(), emailId: inb.messageId },
        { role: "bot", text: replyText, at: new Date().toISOString(), msgNo, agentId },
      ]);
    }

    const summary = firstLineSummary(inb.text || "reply");
    const outSubject = `#${msgNo} [${agentId}] ${summary}`;
    const footer = formatMbCtxFooter({
      convId: meta.convId,
      msgNo,
      agentId,
    });
    const outBody = `${replyText}\n\n${footer}`;

    await this.sendMail({
      to: this.cfg.mail.user,
      subject: outSubject,
      text: outBody,
      inReplyTo: inb.messageId ?? undefined,
      references: inb.references ?? undefined,
      convId: meta.convId,
    });

    this.log.info({ convId: meta.convId, msgNo, agentId }, "Replied");
  }

  /** Strip CR and LF to prevent email header injection. */
  private sanitizeHeader(value: string): string {
    return value.replace(/[\r\n]/g, "");
  }

  private async sendMail(args: {
    to: string;
    subject: string;
    text: string;
    inReplyTo?: string;
    references?: string[];
    convId: string;
  }): Promise<void> {
    const headers: Record<string, string> = {
      "X-Moltbot-Out": "1",
      "X-Moltbot-Conv": args.convId,
    };
    const extraHeaders: Record<string, string> = { ...headers };
    if (args.inReplyTo) extraHeaders["In-Reply-To"] = this.sanitizeHeader(args.inReplyTo);
    if (args.references?.length) extraHeaders["References"] = this.sanitizeHeader(args.references.join(" "));

    await this.smtpTransport.sendMail({
      from: this.cfg.mail.user,
      to: args.to,
      subject: args.subject,
      text: args.text,
      headers: extraHeaders,
    });
  }
}

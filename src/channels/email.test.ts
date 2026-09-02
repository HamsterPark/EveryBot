import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FetchMessageObject } from "imapflow";
import { EmailChannel, sanitizeHeaderValue, type ImapClientLike, type MailTransportLike } from "./email.js";
import { AgentRegistry, LlmAgent } from "../core/agents.js";
import type { LLMProvider } from "../core/llmProvider.js";
import { ConversationStore } from "../conversation/store.js";
import { ProcessedStore } from "../conversation/processedStore.js";
import { formatMbCtxFooter } from "../core/mbctx.js";
import type { AppConfig } from "../config.js";

const OWNER = "owner@example.com";

function makeConfig(mail: Partial<AppConfig["mail"]> = {}): AppConfig {
  return {
    dataDir: "",
    workspaceRoot: "",
    pollIntervalMs: 60_000,
    defaultAgent: "default",
    host: "127.0.0.1",
    port: 0,
    allowedOrigin: null,
    mail: {
      user: OWNER,
      pass: "secret",
      allowedSenders: [],
      allowedRecipients: [],
      imap: { host: "", port: 993, secure: true },
      smtp: { host: "", port: 465, secure: true },
      ...mail,
    },
    llm: {
      baseUrl: "",
      apiKey: "",
      timeoutMs: 1000,
      models: { default: "m", files: "m", scheduler: "m", memorySummary: "m", memoryFacts: "m" },
    },
  };
}

type RawMail = { from: string; subject: string; body: string; messageId?: string; headers?: Record<string, string> };

/** Minimal RFC 5322 message, enough for mailparser. */
function rfc822(m: RawMail): Buffer {
  const lines = [
    `From: ${m.from}`,
    `To: ${OWNER}`,
    `Subject: ${m.subject}`,
    `Message-ID: <${m.messageId ?? Math.random().toString(36).slice(2)}@example.com>`,
    "Date: Tue, 01 Sep 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    ...Object.entries(m.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    "",
    m.body,
  ];
  return Buffer.from(lines.join("\r\n"), "utf-8");
}

class FakeImap implements ImapClientLike {
  usable = true;
  connects = 0;
  fetches = 0;
  readonly seen = new Set<number>();
  private readonly messages = new Map<number, { source: Buffer; from: string }>();
  private nextUid = 1;

  deliver(m: RawMail): number {
    const uid = this.nextUid++;
    this.messages.set(uid, { source: rfc822(m), from: m.from });
    return uid;
  }
  async connect(): Promise<void> {
    this.connects++;
    this.usable = true;
  }
  async logout(): Promise<void> {
    this.usable = false;
  }
  async mailboxOpen(): Promise<unknown> {
    return {};
  }
  async search(): Promise<number[] | false> {
    return [...this.messages.keys()].filter((uid) => !this.seen.has(uid));
  }
  async fetchOne(uid: string, query: { source?: boolean; envelope?: boolean }): Promise<FetchMessageObject | false> {
    this.fetches++;
    const m = this.messages.get(Number(uid));
    if (!m) return false;
    const out = { uid: Number(uid), seq: Number(uid) } as unknown as FetchMessageObject;
    if (query.envelope) out.envelope = { from: [{ address: m.from }] } as FetchMessageObject["envelope"];
    if (query.source) out.source = m.source;
    return out;
  }
  async messageFlagsAdd(uid: string): Promise<boolean> {
    this.seen.add(Number(uid));
    return true;
  }
}

type Sent = Parameters<MailTransportLike["sendMail"]>[0];

describe("sanitizeHeaderValue", () => {
  it("removes CR and LF from header values", () => {
    expect(sanitizeHeaderValue("valid-message-id")).toBe("valid-message-id");
    expect(sanitizeHeaderValue("bad\r\nheader: injected")).toBe("badheader: injected");
    expect(sanitizeHeaderValue("bad\nvalue")).toBe("badvalue");
    expect(sanitizeHeaderValue("bad\rvalue")).toBe("badvalue");
  });

  it("preserves normal reference strings", () => {
    const ref = "<abc123@mail.example.com> <def456@mail.example.com>";
    expect(sanitizeHeaderValue(ref)).toBe(ref);
  });
});

describe("EmailChannel", () => {
  let dir: string;
  let imap: FakeImap;
  let sent: Sent[];
  let smtp: MailTransportLike;
  let convStore: ConversationStore;
  let agents: AgentRegistry;
  let llmCalls: number;
  let provider: LLMProvider;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "everybot-email-"));
    imap = new FakeImap();
    sent = [];
    smtp = {
      sendMail: vi.fn(async (opts: Sent) => {
        sent.push(opts);
        return {};
      }),
    };
    convStore = new ConversationStore(dir);
    llmCalls = 0;
    provider = {
      async chat(req) {
        llmCalls++;
        return { text: `reply to: ${req.messages[req.messages.length - 1].content}` };
      },
    };
    agents = new AgentRegistry();
    agents.register(new LlmAgent("default", provider, "m", "sys"));
    agents.register(new LlmAgent("files", provider, "m", "files sys"));
    logger.info.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function channel(cfg = makeConfig()): EmailChannel {
    return new EmailChannel(cfg, agents, convStore, new ProcessedStore(dir), null, {
      createImap: () => imap,
      smtpTransport: smtp,
      logger,
    });
  }

  /** start() performs the first poll itself; every test calls stop() so the interval is cleared. */
  async function runOnce(ch: EmailChannel): Promise<void> {
    if (ch.isRunning) await ch.pollOnceSafe();
    else await ch.start();
  }

  it("answers mail from the owner with an MBCTX footer and marks it seen", async () => {
    const uid = imap.deliver({ from: OWNER, subject: "hello", body: "What is 2+2?", messageId: "q1" });
    const ch = channel();
    await runOnce(ch);

    expect(sent).toHaveLength(1);
    const mail = sent[0];
    expect(mail.to).toBe(OWNER);
    expect(mail.subject).toBe("#1 [default] What is 2+2?");
    expect(mail.text).toContain("reply to: What is 2+2?");
    expect(mail.text).toMatch(/MBCTX v1 \| c=[A-F0-9]{10} \| m=1 \| a=default/);
    expect(mail.headers).toEqual({ "X-EveryBot-Out": "1", "X-EveryBot-Conv": expect.any(String) });
    expect(mail.inReplyTo).toBe("<q1@example.com>");
    expect(imap.seen.has(uid)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/MAIL_ALLOWED_SENDERS/));

    // A second poll must not answer the same message again.
    await ch.pollOnceSafe();
    expect(sent).toHaveLength(1);
    expect(llmCalls).toBe(1);
    await ch.stop();
  });

  it("ignores mail from senders that are not allow-listed and leaves it unread", async () => {
    const uid = imap.deliver({ from: "spam@example.net", subject: "buy now", body: "cheap watches" });
    const ch = channel();
    await runOnce(ch);

    expect(sent).toHaveLength(0);
    expect(llmCalls).toBe(0);
    expect(imap.seen.has(uid)).toBe(false);

    const fetchesAfterFirstPoll = imap.fetches;
    await ch.pollOnceSafe();
    expect(imap.fetches).toBe(fetchesAfterFirstPoll); // remembered, not re-fetched
    await ch.stop();
  });

  it("treats MAIL_ALLOWED_SENDERS as authoritative and replies to the sender", async () => {
    imap.deliver({ from: "friend@example.org", subject: "hi", body: "ping" });
    imap.deliver({ from: OWNER, subject: "hi", body: "owner ping" });
    const ch = channel(makeConfig({ allowedSenders: ["friend@example.org"] }));
    await runOnce(ch);

    expect(sent.map((m) => m.to)).toEqual(["friend@example.org"]);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(/MAIL_ALLOWED_SENDERS/));
    await ch.stop();
  });

  it("continues a conversation when the reply carries an MBCTX footer", async () => {
    imap.deliver({ from: OWNER, subject: "start", body: "first question" });
    const ch = channel();
    await runOnce(ch);
    const convId = /c=([A-Z0-9]+)/.exec(sent[0].text)![1];

    const footer = formatMbCtxFooter({ convId, msgNo: 1, agentId: "default" });
    imap.deliver({ from: OWNER, subject: "Re: start", body: `second question\n\n> quoted\n${footer}` });
    await ch.pollOnceSafe();

    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toBe("#2 [default] second question");
    expect(sent[1].text).toContain(`c=${convId} | m=2`);
    const thread = await convStore.getThread(convId);
    expect(thread.map((t) => t.role)).toEqual(["user", "bot", "user", "bot"]);
    await ch.stop();
  });

  it("skips its own outgoing mail, including the legacy header name", async () => {
    imap.deliver({ from: OWNER, subject: "#1 [default] echo", body: "bot text", headers: { "X-EveryBot-Out": "1" } });
    imap.deliver({ from: OWNER, subject: "#2 [default] echo", body: "old bot", headers: { "X-Moltbot-Out": "1" } });
    const ch = channel();
    await runOnce(ch);

    expect(sent).toHaveLength(0);
    expect(llmCalls).toBe(0);
    expect(imap.seen.size).toBe(2);
    await ch.stop();
  });

  it("selects the agent from the subject but keeps the conversation's agent for unknown names", async () => {
    imap.deliver({ from: OWNER, subject: "@files list my notes", body: "list" });
    const ch = channel();
    await runOnce(ch);
    expect(sent[0].subject).toMatch(/^#1 \[files\]/);
    const convId = /c=([A-Z0-9]+)/.exec(sent[0].text)![1];

    const footer = formatMbCtxFooter({ convId, msgNo: 1, agentId: "files" });
    imap.deliver({ from: OWNER, subject: "@bogus again", body: `more\n${footer}` });
    await ch.pollOnceSafe();
    expect(sent[1].subject).toMatch(/^#2 \[files\]/);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ subjectAgent: "bogus" }), expect.any(String));
    await ch.stop();
  });

  it("marks the message processed when SMTP fails so the LLM is never called twice", async () => {
    smtp.sendMail = vi.fn(async () => {
      throw new Error("SMTP 451");
    });
    const uid = imap.deliver({ from: OWNER, subject: "hi", body: "question", messageId: "smtpfail" });
    const ch = channel();
    await runOnce(ch);
    expect(llmCalls).toBe(1);
    expect(imap.seen.has(uid)).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: "SMTP 451" }),
      expect.stringMatching(/SMTP/)
    );

    await ch.pollOnceSafe();
    expect(llmCalls).toBe(1);
    // The reply itself was stored, so the user can still read it in the web UI.
    const sessions = await convStore.listConversations();
    expect((await convStore.getThread(sessions[0].convId)).map((t) => t.role)).toEqual(["user", "bot"]);
    await ch.stop();
  });

  it("retries an LLM failure on later polls and gives up after three attempts", async () => {
    provider.chat = async () => {
      llmCalls++;
      throw new Error("LLM HTTP 500");
    };
    const uid = imap.deliver({ from: OWNER, subject: "hi", body: "question", messageId: "llmfail" });
    const ch = channel();
    await runOnce(ch);
    expect(imap.seen.has(uid)).toBe(false);
    await ch.pollOnceSafe();
    expect(imap.seen.has(uid)).toBe(false);
    await ch.pollOnceSafe();
    expect(llmCalls).toBe(3);
    expect(imap.seen.has(uid)).toBe(true); // given up: processed + seen
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/Giving up/));

    await ch.pollOnceSafe();
    expect(llmCalls).toBe(3);
    expect(sent).toHaveLength(0);
    const sessions = await convStore.listConversations();
    expect(sessions.length).toBeGreaterThan(0);
    expect(await convStore.getThread(sessions[0].convId)).toEqual([]); // nothing half-written
    await ch.stop();
  });

  it("reconnects when the IMAP connection is no longer usable", async () => {
    const ch = channel();
    await runOnce(ch);
    expect(imap.connects).toBe(1);

    imap.usable = false;
    imap.deliver({ from: OWNER, subject: "after drop", body: "still there?" });
    await ch.pollOnceSafe();
    expect(imap.connects).toBe(2);
    expect(sent).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/reconnecting/));
    await ch.stop();
  });

  it("does not run two polls at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    provider.chat = async (req) => {
      llmCalls++;
      await gate;
      return { text: `slow reply to: ${req.messages[req.messages.length - 1].content}` };
    };
    imap.deliver({ from: OWNER, subject: "hi", body: "slow question" });
    const ch = channel();
    const starting = ch.start(); // the first poll blocks inside the provider until released
    await new Promise((r) => setTimeout(r, 20));
    expect(llmCalls).toBe(1);

    // Ticks that arrive while a poll is in flight must return immediately, not queue up.
    await Promise.all([ch.pollOnceSafe(), ch.pollOnceSafe()]);
    expect(llmCalls).toBe(1);

    release();
    await starting;
    expect(sent).toHaveLength(1);
    expect(llmCalls).toBe(1);
    await ch.stop();
  });
});

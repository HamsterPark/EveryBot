import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSchedulerExecutor, type ExecutorDeps } from "./executor.js";
import { ApprovalManager } from "../tools/approval.js";
import { AgentRegistry, LlmAgent } from "../core/agents.js";
import { ConversationStore } from "../conversation/store.js";
import type { AppConfig } from "../config.js";
import type { AuditLogger } from "../tools/audit.js";
import type { FileToolsApi } from "../tools/fileTools.js";

function makeConfig(mail: Partial<AppConfig["mail"]> = {}): AppConfig {
  return {
    dataDir: "",
    workspaceRoot: "",
    pollIntervalMs: 1000,
    defaultAgent: "default",
    host: "127.0.0.1",
    port: 0,
    allowedOrigin: null,
    mail: {
      user: "owner@example.com",
      pass: "secret",
      allowedRecipients: [],
      imap: { host: "", port: 993, secure: true },
      smtp: { host: "", port: 465, secure: true },
      ...mail,
    },
    llm: {
      baseUrl: "",
      apiKey: "",
      models: { default: "m", files: "m", scheduler: "m", memorySummary: "m", memoryFacts: "m" },
    },
  };
}

describe("scheduler executor", () => {
  let dir: string;
  let deps: ExecutorDeps;
  let fileTools: FileToolsApi;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "everybot-exec-"));
    fileTools = {
      list: vi.fn(async () => ({ ok: true as const, data: ["a.txt"] })),
      read: vi.fn(async () => ({ ok: true as const, data: "content" })),
      write: vi.fn(async () => ({ ok: true as const, data: "written" })),
      delete: vi.fn(async () => ({ ok: true as const, data: "deleted" })),
    };
    const agents = new AgentRegistry();
    agents.register(
      new LlmAgent("default", { chat: async (req) => ({ text: `re: ${req.messages.at(-1)?.content}` }) }, "m", "sys")
    );
    deps = {
      cfg: makeConfig(),
      fileTools,
      approvalManager: new ApprovalManager(),
      auditLogger: { log: vi.fn(async () => {}) } as unknown as AuditLogger,
      convStore: new ConversationStore(dir),
      agents,
      memoryEngine: null,
      mailer: { sendMail: vi.fn(async () => ({})) },
    };
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("runs read-only file tools directly", async () => {
    const exec = createSchedulerExecutor(deps);
    expect(await exec.runTool("file.list", {})).toEqual({ ok: true, data: ["a.txt"] });
    expect(fileTools.list).toHaveBeenCalledWith(".");
    await exec.runTool("file.read", { path: "a.txt", maxBytes: 10 });
    expect(fileTools.read).toHaveBeenCalledWith("a.txt", 10);
  });

  it("queues file writes and deletes for approval instead of executing them", async () => {
    const exec = createSchedulerExecutor(deps);
    const out = (await exec.runTool("file.write", { path: "notes.md", content: "hi" })) as { pendingId: string };
    expect(out).toMatchObject({ ok: true, pending: true });
    expect(fileTools.write).not.toHaveBeenCalled();

    const pending = deps.approvalManager.list();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: out.pendingId,
      tool: "file.write",
      args: { path: "notes.md", content: "hi" },
    });
    expect(deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "file.write", result: "pending" })
    );

    await exec.runTool("file.delete", { path: "old.txt" });
    expect(fileTools.delete).not.toHaveBeenCalled();
    expect(deps.approvalManager.list()).toHaveLength(2);
  });

  it("rejects unknown tools and missing paths", async () => {
    const exec = createSchedulerExecutor(deps);
    await expect(exec.runTool("shell.exec", {})).rejects.toThrow(/Unknown tool/);
    await expect(exec.runTool("file.delete", {})).rejects.toThrow(/Missing path/);
  });

  it("only mails the owner unless MAIL_ALLOWED_RECIPIENTS says otherwise", async () => {
    const exec = createSchedulerExecutor(deps);
    await exec.sendMessage("mail", undefined, "hello");
    expect(deps.mailer?.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@example.com" }));
    await expect(exec.sendMessage("mail", "stranger@example.com", "hi")).rejects.toThrow(/Recipient not allowed/);

    const strict = createSchedulerExecutor({ ...deps, cfg: makeConfig({ allowedRecipients: ["friend@example.com"] }) });
    await strict.sendMessage("mail", "Friend@Example.com", "hi");
    await expect(strict.sendMessage("mail", "owner@example.com", "hi")).rejects.toThrow(/Recipient not allowed/);
  });

  it("fails loudly when mail is not configured or the channel is unknown", async () => {
    const exec = createSchedulerExecutor({ ...deps, mailer: null });
    await expect(exec.sendMessage("mail", undefined, "x")).rejects.toThrow(/not configured/);
    await expect(createSchedulerExecutor(deps).sendMessage("sms", undefined, "x")).rejects.toThrow(
      /Unsupported channel/
    );
  });

  it("keeps one conversation per task across runs", async () => {
    const exec = createSchedulerExecutor(deps);
    expect(await exec.runChat("status?", { taskId: "daily" })).toBe("re: status?");
    expect(await exec.runChat("status again?", { taskId: "daily" })).toBe("re: status again?");

    const thread = await deps.convStore.getThread("task-daily");
    expect(thread.map((t) => t.role)).toEqual(["user", "bot", "user", "bot"]);
    expect((await deps.convStore.listConversations()).map((m) => m.convId)).toEqual(["task-daily"]);
  });
});

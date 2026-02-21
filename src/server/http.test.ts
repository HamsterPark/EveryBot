import { describe, it, expect, vi } from "vitest";
import http from "node:http";
import { createHttpServer, startHttpServer } from "./http.js";
import type { AppConfig } from "../config.js";
import type { AgentRegistry } from "../core/agents.js";
import { ConversationStore } from "../conversation/store.js";
import { ApprovalManager } from "../tools/approval.js";
import type { FileToolsApi } from "../tools/fileTools.js";
import type { AuditLogger } from "../tools/audit.js";
import os from "node:os";

function makeConfig(): AppConfig {
  return {
    port: 0,
    dataDir: os.tmpdir(),
    workspaceRoot: os.tmpdir(),
    defaultAgent: "default",
    pollIntervalMs: 60000,
    llm: { baseUrl: "", apiKey: "", models: { default: "", files: "", scheduler: "", memorySummary: "", memoryFacts: "" } },
    mail: { user: "", pass: "", imap: { host: "", port: 993, secure: true }, smtp: { host: "", port: 587, secure: false } },
  } as unknown as AppConfig;
}

async function doPost(port: number, pathname: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const raw = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString()) }));
      }
    );
    req.on("error", reject);
    req.end(raw);
  });
}

describe("HTTP server validation", () => {
  it("rejects file write with missing content", async () => {
    const cfg = makeConfig();
    const fileTools: FileToolsApi = { list: vi.fn(), read: vi.fn(), write: vi.fn(), delete: vi.fn() };
    const approvalManager = new ApprovalManager();
    const auditLogger = { log: vi.fn() } as unknown as AuditLogger;
    const convStore = new ConversationStore(os.tmpdir());
    const agents = { has: vi.fn(), get: vi.fn(), register: vi.fn() } as unknown as AgentRegistry;

    const server = createHttpServer(cfg, convStore, agents, null, { fileTools, auditLogger, approvalManager });
    await startHttpServer(server, 0);
    const port = (server.address() as { port: number }).port;
    try {
      const res = await doPost(port, "/api/tools/file/write", { path: "test.txt" });
      expect(res.status).toBe(400);
      expect((res.json as { error: string }).error).toMatch(/content/i);
    } finally {
      server.close();
    }
  });

  it("rejects file write with content exceeding 10 MB", async () => {
    const cfg = makeConfig();
    const fileTools: FileToolsApi = { list: vi.fn(), read: vi.fn(), write: vi.fn(), delete: vi.fn() };
    const approvalManager = new ApprovalManager();
    const auditLogger = { log: vi.fn() } as unknown as AuditLogger;
    const convStore = new ConversationStore(os.tmpdir());
    const agents = { has: vi.fn(), get: vi.fn(), register: vi.fn() } as unknown as AgentRegistry;

    const server = createHttpServer(cfg, convStore, agents, null, { fileTools, auditLogger, approvalManager });
    await startHttpServer(server, 0);
    const port = (server.address() as { port: number }).port;
    try {
      const hugeContent = "x".repeat(11 * 1024 * 1024);
      const res = await doPost(port, "/api/tools/file/write", { path: "big.txt", content: hugeContent });
      expect(res.status).toBe(413);
      expect((res.json as { error: string }).error).toMatch(/too large/i);
    } finally {
      server.close();
    }
  });

  it("rejects task creation with missing cron", async () => {
    const cfg = makeConfig();
    const convStore = new ConversationStore(os.tmpdir());
    const agents = { has: vi.fn(), get: vi.fn(), register: vi.fn() } as unknown as AgentRegistry;
    const schedulerEngine = { getTasks: vi.fn(), addTask: vi.fn(), getEnabledTasks: vi.fn() } as unknown;

    const server = createHttpServer(cfg, convStore, agents, null, { schedulerEngine: schedulerEngine as import("../scheduler/schedulerEngine.js").SchedulerEngine });
    await startHttpServer(server, 0);
    const port = (server.address() as { port: number }).port;
    try {
      const res = await doPost(port, "/api/tasks", { action: { type: "runChat", promptTemplate: "hello" } });
      expect(res.status).toBe(400);
      expect((res.json as { error: string }).error).toMatch(/cron/i);
    } finally {
      server.close();
    }
  });

  it("rejects task creation with missing action", async () => {
    const cfg = makeConfig();
    const convStore = new ConversationStore(os.tmpdir());
    const agents = { has: vi.fn(), get: vi.fn(), register: vi.fn() } as unknown as AgentRegistry;
    const schedulerEngine = { getTasks: vi.fn(), addTask: vi.fn(), getEnabledTasks: vi.fn() } as unknown;

    const server = createHttpServer(cfg, convStore, agents, null, { schedulerEngine: schedulerEngine as import("../scheduler/schedulerEngine.js").SchedulerEngine });
    await startHttpServer(server, 0);
    const port = (server.address() as { port: number }).port;
    try {
      const res = await doPost(port, "/api/tasks", { cron: "* * * * *" });
      expect(res.status).toBe(400);
      expect((res.json as { error: string }).error).toMatch(/action/i);
    } finally {
      server.close();
    }
  });
});

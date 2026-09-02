import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHttpServer, startHttpServer, type HttpServerDeps } from "./http.js";
import type { AppConfig } from "../config.js";
import { AgentRegistry, LlmAgent } from "../core/agents.js";
import type { LLMProvider } from "../core/llmProvider.js";
import { ConversationStore } from "../conversation/store.js";
import { ApprovalManager } from "../tools/approval.js";
import type { FileToolsApi } from "../tools/fileTools.js";
import type { AuditLogger } from "../tools/audit.js";
import type { SchedulerEngine } from "../scheduler/schedulerEngine.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    allowedOrigin: null,
    dataDir: os.tmpdir(),
    workspaceRoot: os.tmpdir(),
    defaultAgent: "default",
    pollIntervalMs: 60000,
    llm: {
      baseUrl: "",
      apiKey: "",
      models: { default: "", files: "", scheduler: "", memorySummary: "", memoryFacts: "" },
    },
    mail: {
      user: "",
      pass: "",
      imap: { host: "", port: 993, secure: true },
      smtp: { host: "", port: 587, secure: false },
    },
    ...overrides,
  } as AppConfig;
}

type Response = { status: number; headers: http.IncomingHttpHeaders; json: unknown };

function request(
  port: number,
  method: string,
  pathname: string,
  opts: { body?: unknown; rawBody?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
  const raw = opts.rawBody ?? (opts.body === undefined ? "" : JSON.stringify(opts.body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(raw),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json: unknown;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
        });
      }
    );
    req.on("error", reject);
    req.end(raw);
  });
}

const stubFileTools = (): FileToolsApi => ({ list: vi.fn(), read: vi.fn(), write: vi.fn(), delete: vi.fn() });
const stubAgents = () => ({ has: vi.fn(), get: vi.fn(), register: vi.fn() }) as unknown as AgentRegistry;
const stubAudit = () => ({ log: vi.fn() }) as unknown as AuditLogger;

const servers: http.Server[] = [];
const tmpDirs: string[] = [];

async function startServer(
  cfg: AppConfig,
  convStore: ConversationStore,
  agents: AgentRegistry,
  deps: HttpServerDeps = {}
): Promise<number> {
  const server = createHttpServer(cfg, convStore, agents, null, deps);
  await startHttpServer(server, 0, "127.0.0.1");
  servers.push(server);
  return (server.address() as { port: number }).port;
}

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "everybot-http-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe("HTTP server input validation", () => {
  it("rejects file write with missing content", async () => {
    const port = await startServer(makeConfig(), new ConversationStore(await tmpDir()), stubAgents(), {
      fileTools: stubFileTools(),
      auditLogger: stubAudit(),
      approvalManager: new ApprovalManager(),
    });
    const res = await request(port, "POST", "/api/tools/file/write", { body: { path: "test.txt" } });
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toMatch(/content/i);
  });

  it("rejects a request body larger than 1 MB with 413 while streaming", async () => {
    const port = await startServer(makeConfig(), new ConversationStore(await tmpDir()), stubAgents(), {
      fileTools: stubFileTools(),
      auditLogger: stubAudit(),
      approvalManager: new ApprovalManager(),
    });
    const hugeContent = "x".repeat(1024 * 1024 + 1024);
    const res = await request(port, "POST", "/api/tools/file/write", {
      body: { path: "big.txt", content: hugeContent },
    });
    expect(res.status).toBe(413);
    expect((res.json as { error: string }).error).toMatch(/too large/i);
  });

  it("rejects malformed JSON with 400 instead of 500", async () => {
    const port = await startServer(makeConfig(), new ConversationStore(await tmpDir()), stubAgents());
    const res = await request(port, "POST", "/api/chat", { rawBody: "{not json" });
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toMatch(/json/i);
  });

  it("rejects task creation with missing cron", async () => {
    const schedulerEngine = {
      getTasks: vi.fn(),
      addTask: vi.fn(),
      getEnabledTasks: vi.fn(),
    } as unknown as SchedulerEngine;
    const port = await startServer(makeConfig(), new ConversationStore(await tmpDir()), stubAgents(), {
      schedulerEngine,
    });
    const res = await request(port, "POST", "/api/tasks", {
      body: { action: { type: "runChat", promptTemplate: "hello" } },
    });
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toMatch(/cron/i);
  });

  it("rejects task creation with missing action", async () => {
    const schedulerEngine = {
      getTasks: vi.fn(),
      addTask: vi.fn(),
      getEnabledTasks: vi.fn(),
    } as unknown as SchedulerEngine;
    const port = await startServer(makeConfig(), new ConversationStore(await tmpDir()), stubAgents(), {
      schedulerEngine,
    });
    const res = await request(port, "POST", "/api/tasks", { body: { cron: "* * * * *" } });
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toMatch(/action/i);
  });

  it("rejects session ids that could escape the data directory", async () => {
    const port = await startServer(makeConfig(), new ConversationStore(await tmpDir()), stubAgents());
    const chat = await request(port, "POST", "/api/chat", { body: { sessionId: "../../etc", message: "hi" } });
    expect(chat.status).toBe(400);
    expect((chat.json as { error: string }).error).toMatch(/sessionId/);

    const thread = await request(port, "GET", "/api/thread?sessionId=" + encodeURIComponent("../x"));
    expect(thread.status).toBe(400);
  });
});

describe("HTTP server CORS", () => {
  it("sends no CORS headers by default", async () => {
    const port = await startServer(makeConfig(), new ConversationStore(await tmpDir()), stubAgents());
    const res = await request(port, "GET", "/health", { headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("echoes only the configured origin", async () => {
    const cfg = makeConfig({ allowedOrigin: "http://localhost:5173" });
    const port = await startServer(cfg, new ConversationStore(await tmpDir()), stubAgents());

    const allowed = await request(port, "GET", "/health", { headers: { Origin: "http://localhost:5173" } });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");

    const other = await request(port, "GET", "/health", { headers: { Origin: "http://localhost:9999" } });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("HTTP chat end-to-end with a mock provider", () => {
  const echoProvider: LLMProvider = {
    async chat(req) {
      const last = req.messages[req.messages.length - 1];
      return { text: `echo: ${last.content} (history=${req.messages.length})` };
    },
  };

  it("creates a session, replies, and continues the same session", async () => {
    const dataDir = await tmpDir();
    const convStore = new ConversationStore(dataDir);
    const agents = new AgentRegistry();
    agents.register(new LlmAgent("default", echoProvider, "mock-model", "You are a test bot."));
    const port = await startServer(makeConfig({ dataDir }), convStore, agents);

    const first = await request(port, "POST", "/api/chat", { body: { message: "hello" } });
    expect(first.status).toBe(200);
    const firstJson = first.json as { sessionId: string; reply: string; msgNo: number };
    expect(firstJson.reply).toBe("echo: hello (history=2)");
    expect(firstJson.msgNo).toBe(1);
    expect(firstJson.sessionId).toMatch(/^[A-F0-9]{10}$/);

    const second = await request(port, "POST", "/api/chat", {
      body: { sessionId: firstJson.sessionId, message: "again" },
    });
    const secondJson = second.json as { sessionId: string; reply: string; msgNo: number };
    expect(secondJson.sessionId).toBe(firstJson.sessionId);
    expect(secondJson.msgNo).toBe(2);
    // system + 2 earlier turns + the new user message
    expect(secondJson.reply).toBe("echo: again (history=4)");

    const thread = await request(port, "GET", `/api/thread?sessionId=${firstJson.sessionId}`);
    const items = (thread.json as { thread: Array<{ role: string; text: string }> }).thread;
    expect(items.map((t) => t.role)).toEqual(["user", "bot", "user", "bot"]);

    const sessions = await request(port, "GET", "/api/sessions");
    const list = (sessions.json as { sessions: Array<{ convId: string }> }).sessions;
    expect(list.map((s) => s.convId)).toEqual([firstJson.sessionId]);
  });

  it("falls back to the default agent for unknown agent ids", async () => {
    const dataDir = await tmpDir();
    const convStore = new ConversationStore(dataDir);
    const agents = new AgentRegistry();
    agents.register(new LlmAgent("default", echoProvider, "mock-model", "sys"));
    const port = await startServer(makeConfig({ dataDir }), convStore, agents);

    const res = await request(port, "POST", "/api/chat", { body: { message: "x", agentId: "nope" } });
    expect(res.status).toBe(200);
    const meta = await convStore.loadMeta((res.json as { sessionId: string }).sessionId);
    expect(meta.agentId).toBe("default");
  });
});

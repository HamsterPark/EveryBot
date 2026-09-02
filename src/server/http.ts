import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConversationStore } from "../conversation/store.js";
import { isValidId } from "../conversation/ids.js";
import type { AgentRegistry } from "../core/agents.js";
import type { AppConfig } from "../config.js";
import type { MemoryPack } from "../core/agents.js";
import type { MemoryEngine } from "../memory/memoryEngine.js";
import type { FileToolsApi, FileToolResult } from "../tools/fileTools.js";
import type { AuditLogger } from "../tools/audit.js";
import type { ApprovalManager } from "../tools/approval.js";
import type { SchedulerEngine, TaskAction } from "../scheduler/schedulerEngine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, "..", "..", "ui");

/** Largest request body accepted by any endpoint. Enforced while streaming, not after buffering. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Error carrying an HTTP status; anything else thrown by a handler becomes a 500. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    let tooLarge = Number.isFinite(declared) && declared > maxBytes;
    let received = 0;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      // Keep draining an oversized body so the client can still read our 413,
      // but stop buffering it.
      if (tooLarge) return;
      received += chunk.length;
      if (received > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) reject(new HttpError(413, "Request body too large"));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBody(req, MAX_BODY_BYTES)).toString("utf-8");
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `Invalid ${name}`);
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new HttpError(400, `Missing or invalid ${name}`);
  return value;
}

function requireId(value: unknown, name: string): string {
  if (!isValidId(value)) throw new HttpError(400, `Invalid ${name}`);
  return value;
}

/**
 * CORS is opt-in: without ALLOWED_ORIGIN no CORS headers are sent, so browsers refuse
 * cross-origin calls from arbitrary web pages to this unauthenticated local API.
 */
function applyCors(req: IncomingMessage, res: ServerResponse, allowedOrigin: string | null): void {
  const origin = req.headers.origin;
  if (!allowedOrigin || !origin || origin !== allowedOrigin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export type HttpServerDeps = {
  fileTools?: FileToolsApi;
  auditLogger?: AuditLogger;
  approvalManager?: ApprovalManager;
  schedulerEngine?: SchedulerEngine;
};

export function createHttpServer(
  cfg: AppConfig,
  convStore: ConversationStore,
  agents: AgentRegistry,
  memoryEngine: MemoryEngine | null,
  deps?: HttpServerDeps
): ReturnType<typeof createServer> {
  const { fileTools, auditLogger, approvalManager, schedulerEngine } = deps ?? {};

  async function audit(tool: string, args: unknown, out: FileToolResult): Promise<void> {
    if (!auditLogger) return;
    await auditLogger.log({
      tool,
      args,
      result: out.ok ? "ok" : "error",
      detail: out.ok ? undefined : out.error,
    });
  }

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    applyCors(req, res, cfg.allowedOrigin);
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? "/";
    const pathname = url.split("?")[0];

    try {
      if (pathname === "/health" && req.method === "GET") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === "/api/sessions" && req.method === "GET") {
        const list = await convStore.listConversations();
        sendJson(res, 200, { sessions: list });
        return;
      }

      if (pathname === "/api/chat" && req.method === "POST") {
        const body = await parseBody(req);
        const message = requireString(body.message, "message");
        const sessionId = body.sessionId ? requireId(body.sessionId, "sessionId") : undefined;
        const requestedAgent = optionalString(body.agentId, "agentId") ?? cfg.defaultAgent;
        const effectiveAgent = agents.has(requestedAgent) ? requestedAgent : cfg.defaultAgent;

        const meta = sessionId
          ? await convStore.ensureConversation(sessionId, effectiveAgent)
          : await convStore.createConversation(effectiveAgent);

        if (effectiveAgent !== meta.agentId) {
          meta.agentId = effectiveAgent;
          await convStore.saveMeta(meta);
        }

        // Build the context from turns *before* this message; the agent appends the
        // current user message itself, so persisting it first would send it twice.
        const memory: MemoryPack = memoryEngine
          ? await memoryEngine.buildMemoryPack(meta.convId)
          : {
              summary: "",
              facts: {},
              recentTurns: (await convStore.getThread(meta.convId)).map((t) => ({ role: t.role, text: t.text })),
            };

        await convStore.append(meta.convId, {
          role: "user",
          text: message,
          at: new Date().toISOString(),
        });

        const agent = agents.get(effectiveAgent);
        const replyText = await agent.handle(message, { convId: meta.convId, agentId: effectiveAgent }, memory);

        const msgNo = await convStore.nextBotMsgNo(meta.convId);
        await convStore.append(meta.convId, {
          role: "bot",
          text: replyText,
          at: new Date().toISOString(),
          msgNo,
          agentId: effectiveAgent,
        });

        if (memoryEngine) {
          await memoryEngine.afterReply(meta.convId, [
            { role: "user", text: message, at: new Date().toISOString() },
            { role: "bot", text: replyText, at: new Date().toISOString(), msgNo, agentId: effectiveAgent },
          ]);
        }

        sendJson(res, 200, {
          sessionId: meta.convId,
          reply: replyText,
          msgNo,
        });
        return;
      }

      if (pathname === "/api/thread" && req.method === "GET") {
        const u = new URL(url, "http://localhost");
        const sessionId = requireId(u.searchParams.get("sessionId"), "sessionId");
        const thread = await convStore.getThread(sessionId);
        sendJson(res, 200, { thread });
        return;
      }

      if (fileTools && pathname === "/api/tools/file/list" && req.method === "POST") {
        const body = await parseBody(req);
        const p = optionalString(body.path, "path") ?? ".";
        const out = await fileTools.list(p);
        await audit("file.list", { path: p }, out);
        sendJson(res, 200, out);
        return;
      }

      if (fileTools && pathname === "/api/tools/file/read" && req.method === "POST") {
        const body = await parseBody(req);
        const p = requireString(body.path, "path");
        const maxBytes = typeof body.maxBytes === "number" && body.maxBytes > 0 ? body.maxBytes : 1_000_000;
        const out = await fileTools.read(p, maxBytes);
        await audit("file.read", { path: p }, out);
        sendJson(res, 200, out);
        return;
      }

      if (fileTools && approvalManager && pathname === "/api/tools/file/write" && req.method === "POST") {
        const body = await parseBody(req);
        const p = requireString(body.path, "path");
        const content = body.content;
        if (typeof content !== "string") throw new HttpError(400, "Missing or invalid content");
        const id = approvalManager.add("file.write", { path: p, content });
        if (auditLogger)
          await auditLogger.log({ tool: "file.write", args: { path: p }, result: "pending", detail: id });
        sendJson(res, 200, { pendingId: id, message: "Approval required" });
        return;
      }

      if (fileTools && approvalManager && pathname === "/api/tools/file/delete" && req.method === "POST") {
        const body = await parseBody(req);
        const p = requireString(body.path, "path");
        const id = approvalManager.add("file.delete", { path: p });
        if (auditLogger)
          await auditLogger.log({ tool: "file.delete", args: { path: p }, result: "pending", detail: id });
        sendJson(res, 200, { pendingId: id, message: "Approval required" });
        return;
      }

      if (schedulerEngine && pathname === "/api/tasks" && req.method === "GET") {
        const tasks = schedulerEngine.getTasks();
        sendJson(res, 200, { tasks });
        return;
      }

      if (schedulerEngine && pathname === "/api/tasks" && req.method === "POST") {
        const body = await parseBody(req);
        const cron = requireString(body.cron, "cron");
        if (!body.action || typeof body.action !== "object" || Array.isArray(body.action)) {
          throw new HttpError(400, "Missing or invalid action");
        }
        const task = await schedulerEngine.addTask({
          id: optionalString(body.id, "id") ?? randomUUID(),
          cron,
          timezone: optionalString(body.timezone, "timezone"),
          action: body.action as TaskAction,
          enabled: typeof body.enabled === "boolean" ? body.enabled : true,
        });
        sendJson(res, 200, task);
        return;
      }

      if (approvalManager && pathname === "/api/approvals" && req.method === "GET") {
        sendJson(res, 200, { pending: approvalManager.list() });
        return;
      }

      if (fileTools && approvalManager && pathname.startsWith("/api/approvals/") && req.method === "POST") {
        const [id, action] = pathname.slice("/api/approvals/".length).split("/");
        if (!id) throw new HttpError(400, "Missing id");

        if (action === "approve") {
          const p = approvalManager.approve(id);
          if (!p) throw new HttpError(404, "Not found");
          let out: FileToolResult;
          if (p.tool === "file.write") {
            const args = p.args as { path: string; content: string };
            out = await fileTools.write(args.path, args.content);
          } else if (p.tool === "file.delete") {
            const args = p.args as { path: string };
            out = await fileTools.delete(args.path);
          } else {
            throw new HttpError(400, "Unknown tool");
          }
          await audit(p.tool, p.args, out);
          sendJson(res, 200, out);
          return;
        }
        if (action === "reject") {
          const ok = approvalManager.reject(id);
          sendJson(res, 200, { rejected: ok });
          return;
        }
      }

      if ((pathname === "/" || pathname === "/index.html") && req.method === "GET") {
        const htmlPath = path.join(UI_DIR, "index.html");
        const content = await fs.readFile(htmlPath, "utf-8");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.writeHead(200);
        res.end(content);
        return;
      }

      sendJson(res, 404, { error: "Not Found" });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, status, { error: message });
    }
  });
}

export function startHttpServer(
  server: ReturnType<typeof createServer>,
  port: number,
  host = "127.0.0.1"
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}

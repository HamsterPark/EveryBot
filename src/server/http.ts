import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConversationStore } from "../conversation/store.js";
import type { AgentRegistry } from "../core/agents.js";
import type { AppConfig } from "../config.js";
import type { MemoryPack } from "../core/agents.js";
import type { MemoryEngine } from "../memory/memoryEngine.js";
import type { FileToolsApi } from "../tools/fileTools.js";
import type { AuditLogger } from "../tools/audit.js";
import type { ApprovalManager } from "../tools/approval.js";
import type { SchedulerEngine } from "../scheduler/schedulerEngine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, "..", "..", "ui");

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        if (!raw.trim()) {
          resolve({});
          return;
        }
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

export function createHttpServer(
  cfg: AppConfig,
  convStore: ConversationStore,
  agents: AgentRegistry,
  memoryEngine: MemoryEngine | null,
  deps?: {
    fileTools?: FileToolsApi;
    auditLogger?: AuditLogger;
    approvalManager?: ApprovalManager;
    schedulerEngine?: SchedulerEngine;
  }
): ReturnType<typeof createServer> {
  const { fileTools, auditLogger, approvalManager, schedulerEngine } = deps ?? {};
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? "/";
    const pathname = url.split("?")[0];

    try {
      if (pathname === "/api/sessions" && req.method === "GET") {
        const list = await convStore.listConversations();
        sendJson(res, 200, { sessions: list });
        return;
      }

      if (pathname === "/api/chat" && req.method === "POST") {
        const body = await parseBody(req);
        const sessionId = body.sessionId as string | undefined;
        const message = body.message as string | undefined;
        if (!message || typeof message !== "string") {
          sendJson(res, 400, { error: "Missing or invalid message" });
          return;
        }

        const agentId = (body.agentId as string) ?? cfg.defaultAgent;
        const meta = sessionId
          ? await convStore.ensureConversation(sessionId, agentId)
          : await convStore.createConversation(agentId);

        const effectiveAgent = agents.has(agentId) ? agentId : cfg.defaultAgent;
        if (effectiveAgent !== meta.agentId) {
          meta.agentId = effectiveAgent;
          await convStore.saveMeta(meta);
        }

        await convStore.append(meta.convId, {
          role: "user",
          text: message,
          at: new Date().toISOString(),
        });

        const memory: MemoryPack = memoryEngine
          ? await memoryEngine.buildMemoryPack(meta.convId)
          : { summary: "", facts: {}, recentTurns: (await convStore.getThread(meta.convId)).map((t) => ({ role: t.role, text: t.text })) };

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
        const sessionId = u.searchParams.get("sessionId");
        if (!sessionId) {
          sendJson(res, 400, { error: "Missing sessionId" });
          return;
        }
        const thread = await convStore.getThread(sessionId);
        sendJson(res, 200, { thread });
        return;
      }

      if (pathname === "/health" && req.method === "GET") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (fileTools && pathname === "/api/tools/file/list" && req.method === "POST") {
        const body = await parseBody(req);
        const p = (body.path as string) ?? ".";
        const out = await fileTools.list(p);
        if (auditLogger) await auditLogger.log({ tool: "file.list", args: { path: p }, result: out.ok ? "ok" : "error", detail: out.ok ? undefined : (out as { error: string }).error });
        sendJson(res, 200, out);
        return;
      }

      if (fileTools && pathname === "/api/tools/file/read" && req.method === "POST") {
        const body = await parseBody(req);
        const p = body.path as string;
        const maxBytes = (body.maxBytes as number) ?? 1_000_000;
        if (!p) { sendJson(res, 400, { error: "Missing path" }); return; }
        const out = await fileTools.read(p, maxBytes);
        if (auditLogger) await auditLogger.log({ tool: "file.read", args: { path: p }, result: out.ok ? "ok" : "error", detail: out.ok ? undefined : (out as { error: string }).error });
        sendJson(res, 200, out);
        return;
      }

      const MAX_WRITE_BYTES = 10 * 1024 * 1024; // 10 MB
      if (fileTools && approvalManager && pathname === "/api/tools/file/write" && req.method === "POST") {
        const body = await parseBody(req);
        const p = body.path as string;
        const content = body.content;
        if (!p) { sendJson(res, 400, { error: "Missing path" }); return; }
        if (typeof content !== "string") { sendJson(res, 400, { error: "Missing or invalid content" }); return; }
        if (Buffer.byteLength(content, "utf-8") > MAX_WRITE_BYTES) { sendJson(res, 413, { error: "Content too large" }); return; }
        const id = approvalManager.add("file.write", { path: p, content });
        if (auditLogger) await auditLogger.log({ tool: "file.write", args: { path: p }, result: "pending", detail: id });
        sendJson(res, 200, { pendingId: id, message: "Approval required" });
        return;
      }

      if (fileTools && approvalManager && pathname === "/api/tools/file/delete" && req.method === "POST") {
        const body = await parseBody(req);
        const p = body.path as string;
        if (!p) { sendJson(res, 400, { error: "Missing path" }); return; }
        const id = approvalManager.add("file.delete", { path: p });
        if (auditLogger) await auditLogger.log({ tool: "file.delete", args: { path: p }, result: "pending", detail: id });
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
        if (!body.cron || typeof body.cron !== "string") { sendJson(res, 400, { error: "Missing or invalid cron" }); return; }
        if (!body.action || typeof body.action !== "object" || Array.isArray(body.action)) { sendJson(res, 400, { error: "Missing or invalid action" }); return; }
        const task = await schedulerEngine.addTask({
          id: (body.id as string) ?? crypto.randomUUID(),
          cron: body.cron,
          timezone: body.timezone as string | undefined,
          action: body.action as import("../scheduler/schedulerEngine.js").TaskAction,
          enabled: (body.enabled as boolean) ?? true,
        });
        sendJson(res, 200, task);
        return;
      }

      if (approvalManager && pathname === "/api/approvals" && req.method === "GET") {
        sendJson(res, 200, { pending: approvalManager.list() });
        return;
      }

      if (fileTools && auditLogger && approvalManager && pathname.startsWith("/api/approvals/") && req.method === "POST") {
        const parts = pathname.slice("/api/approvals/".length).split("/");
        const id = parts[0];
        const action = parts[1];
        if (!id) { sendJson(res, 400, { error: "Missing id" }); return; }
        if (action === "approve") {
          const p = approvalManager.approve(id);
          if (!p) { sendJson(res, 404, { error: "Not found" }); return; }
          let out: { ok: boolean; data?: string | string[]; error?: string };
          if (p.tool === "file.write") {
            const args = p.args as { path: string; content: string };
            out = await fileTools.write(args.path, args.content);
          } else if (p.tool === "file.delete") {
            const args = p.args as { path: string };
            out = await fileTools.delete(args.path);
          } else { sendJson(res, 400, { error: "Unknown tool" }); return; }
          await auditLogger.log({ tool: p.tool, args: p.args, result: out.ok ? "ok" : "error", detail: out.ok ? undefined : (out as { error: string }).error });
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

      res.writeHead(404);
      res.end("Not Found");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
  });
}

export function startHttpServer(
  server: ReturnType<typeof createServer>,
  port: number
): Promise<void> {
  return new Promise((resolve) => {
    server.listen(port, () => resolve());
  });
}

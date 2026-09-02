import type { AppConfig } from "../config.js";
import type { AgentRegistry } from "../core/agents.js";
import { isAllowedAddress } from "../core/allowlist.js";
import { runConversationTurn } from "../core/conversationTurn.js";
import type { ConversationStore } from "../conversation/store.js";
import type { MemoryEngine } from "../memory/memoryEngine.js";
import type { ApprovalManager } from "../tools/approval.js";
import type { AuditLogger } from "../tools/audit.js";
import type { FileToolsApi } from "../tools/fileTools.js";
import type { SchedulerExecutor } from "./runner.js";

export type Mailer = {
  sendMail(options: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
};

export type ExecutorDeps = {
  cfg: AppConfig;
  fileTools: FileToolsApi;
  approvalManager: ApprovalManager;
  auditLogger: AuditLogger;
  convStore: ConversationStore;
  agents: AgentRegistry;
  memoryEngine: MemoryEngine | null;
  /** null when mail is not configured */
  mailer: Mailer | null;
};

export type PendingToolResult = { ok: true; pending: true; pendingId: string };

/**
 * Executes scheduler actions with the same guard rails as the HTTP API:
 * file writes/deletes are queued for approval instead of running unattended,
 * mail can only go to allow-listed recipients, and scheduled chats keep one
 * stable conversation per task instead of creating a new one on every tick.
 */
export function createSchedulerExecutor(deps: ExecutorDeps): SchedulerExecutor {
  const { cfg, fileTools, approvalManager, auditLogger, convStore, agents, memoryEngine, mailer } = deps;

  return {
    async sendMessage(channel, target, text): Promise<void> {
      if (channel !== "mail") throw new Error(`Unsupported channel: ${channel}`);
      if (!mailer || !cfg.mail.user) throw new Error("Mail is not configured (MAIL_USER / MAIL_PASS)");
      const to = target ?? cfg.mail.user;
      if (!isAllowedAddress(to, cfg.mail.allowedRecipients, cfg.mail.user)) {
        throw new Error(`Recipient not allowed: ${to} (see MAIL_ALLOWED_RECIPIENTS)`);
      }
      await mailer.sendMail({ from: cfg.mail.user, to, subject: "[EveryBot] Scheduled", text });
    },

    async runTool(toolName, args): Promise<unknown> {
      const p = typeof args.path === "string" ? args.path : undefined;
      switch (toolName) {
        case "file.list":
          return fileTools.list(p ?? ".");
        case "file.read": {
          const maxBytes = typeof args.maxBytes === "number" && args.maxBytes > 0 ? args.maxBytes : 1_000_000;
          return fileTools.read(p ?? "", maxBytes);
        }
        case "file.write":
        case "file.delete": {
          if (!p) throw new Error(`Missing path for ${toolName}`);
          const toolArgs =
            toolName === "file.write"
              ? { path: p, content: typeof args.content === "string" ? args.content : "" }
              : { path: p };
          const pendingId = approvalManager.add(toolName, toolArgs);
          await auditLogger.log({
            tool: toolName,
            args: { path: p },
            result: "pending",
            detail: `scheduler:${pendingId}`,
          });
          const result: PendingToolResult = { ok: true, pending: true, pendingId };
          return result;
        }
        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    },

    async runChat(promptTemplate, ctx): Promise<string> {
      const meta = await convStore.getOrCreateConversation(`task-${ctx.taskId}`, cfg.defaultAgent);
      const { replyText } = await runConversationTurn(
        { convStore, agents, memoryEngine },
        meta,
        cfg.defaultAgent,
        promptTemplate
      );
      return replyText;
    },
  };
}

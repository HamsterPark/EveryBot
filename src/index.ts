import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { SiliconFlowProvider } from "./core/llmProvider.js";
import { AgentRegistry, createDefaultAgents } from "./core/agents.js";
import { WorkspaceFS } from "./core/workspaceFs.js";
import { ConversationStore } from "./conversation/store.js";
import { ProcessedStore } from "./conversation/processedStore.js";
import { MemoryEngine } from "./memory/memoryEngine.js";
import { createFileTools } from "./tools/fileTools.js";
import { AuditLogger } from "./tools/audit.js";
import { ApprovalManager } from "./tools/approval.js";
import nodemailer from "nodemailer";
import { createHttpServer, startHttpServer } from "./server/http.js";
import { EmailChannel } from "./channels/email.js";
import { SchedulerEngine } from "./scheduler/schedulerEngine.js";
import { SchedulerRunner } from "./scheduler/runner.js";
import type { SchedulerExecutor } from "./scheduler/runner.js";

async function ensureDirs(dataDir: string): Promise<void> {
  await fs.mkdir(path.join(dataDir, "conv"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "workspace"), { recursive: true });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  await ensureDirs(cfg.dataDir);

  const provider = new SiliconFlowProvider(cfg.llm.baseUrl, cfg.llm.apiKey);
  const agents = new AgentRegistry();
  for (const a of createDefaultAgents({
    provider,
    models: {
      default: cfg.llm.models.default,
      files: cfg.llm.models.files,
      scheduler: cfg.llm.models.scheduler,
    },
  })) {
    agents.register(a);
  }

  const convStore = new ConversationStore(cfg.dataDir);
  const memoryEngine = new MemoryEngine(
    cfg.dataDir,
    convStore,
    cfg.llm.apiKey ? provider : null,
    { summary: cfg.llm.models.memorySummary, facts: cfg.llm.models.memoryFacts }
  );

  const workspaceFs = new WorkspaceFS(cfg.workspaceRoot);
  const fileTools = createFileTools(workspaceFs);
  const auditLogger = new AuditLogger(cfg.dataDir);
  const approvalManager = new ApprovalManager();

  const schedulerEngine = new SchedulerEngine(cfg.dataDir);
  await schedulerEngine.load();

  const server = createHttpServer(cfg, convStore, agents, memoryEngine, {
    fileTools,
    auditLogger,
    approvalManager,
    schedulerEngine,
  });
  await startHttpServer(server, cfg.port);

  // eslint-disable-next-line no-console
  console.log(`[EveryBot] HTTP server listening on http://localhost:${cfg.port}`);

  const processedStore = new ProcessedStore(cfg.dataDir);
  const emailChannel = new EmailChannel(cfg, agents, convStore, processedStore, memoryEngine);
  await emailChannel.start();

  const smtpTransport =
    cfg.mail.user && cfg.mail.pass
      ? nodemailer.createTransport({
          host: cfg.mail.smtp.host,
          port: cfg.mail.smtp.port,
          secure: cfg.mail.smtp.secure,
          auth: { user: cfg.mail.user, pass: cfg.mail.pass },
        })
      : null;

  const executor: SchedulerExecutor = {
    async sendMessage(channel: string, target: string | undefined, text: string): Promise<void> {
      if (channel === "mail" && smtpTransport && cfg.mail.user) {
        await smtpTransport.sendMail({
          from: cfg.mail.user,
          to: target ?? cfg.mail.user,
          subject: "[EveryBot] Scheduled",
          text,
        });
      }
    },
    async runTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
      if (toolName === "file.list") return await fileTools.list((args.path as string) ?? ".");
      if (toolName === "file.read") return await fileTools.read((args.path as string) ?? "", (args.maxBytes as number) ?? 1_000_000);
      if (toolName === "file.write") return await fileTools.write((args.path as string) ?? "", (args.content as string) ?? "");
      if (toolName === "file.delete") return await fileTools.delete((args.path as string) ?? "");
      throw new Error(`Unknown tool: ${toolName}`);
    },
    async runChat(promptTemplate: string): Promise<string> {
      const meta = await convStore.createConversation(cfg.defaultAgent);
      const memory = memoryEngine ? await memoryEngine.buildMemoryPack(meta.convId) : { summary: "", facts: {}, recentTurns: [] };
      const agent = agents.get(cfg.defaultAgent);
      return await agent.handle(promptTemplate, { convId: meta.convId, agentId: cfg.defaultAgent }, memory);
    },
  };

  const schedulerRunner = new SchedulerRunner(schedulerEngine, executor);
  await schedulerRunner.start();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

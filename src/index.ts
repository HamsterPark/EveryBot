// Load .env before anything reads process.env (side-effect import must stay first).
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import nodemailer from "nodemailer";
import { loadConfig } from "./config.js";
import { OpenAICompatibleProvider } from "./core/llmProvider.js";
import { AgentRegistry, createDefaultAgents } from "./core/agents.js";
import { WorkspaceFS } from "./core/workspaceFs.js";
import { ConversationStore } from "./conversation/store.js";
import { ProcessedStore } from "./conversation/processedStore.js";
import { MemoryEngine } from "./memory/memoryEngine.js";
import { createFileTools } from "./tools/fileTools.js";
import { AuditLogger } from "./tools/audit.js";
import { ApprovalManager } from "./tools/approval.js";
import { createHttpServer, startHttpServer } from "./server/http.js";
import { EmailChannel } from "./channels/email.js";
import { SchedulerEngine } from "./scheduler/schedulerEngine.js";
import { SchedulerRunner } from "./scheduler/runner.js";
import { createSchedulerExecutor } from "./scheduler/executor.js";

async function ensureDirs(dataDir: string): Promise<void> {
  await fs.mkdir(path.join(dataDir, "conv"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "workspace"), { recursive: true });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  await ensureDirs(cfg.dataDir);

  const provider = new OpenAICompatibleProvider(cfg.llm.baseUrl, cfg.llm.apiKey, { timeoutMs: cfg.llm.timeoutMs });
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
  const memoryEngine = new MemoryEngine(cfg.dataDir, convStore, cfg.llm.apiKey ? provider : null, {
    summary: cfg.llm.models.memorySummary,
    facts: cfg.llm.models.memoryFacts,
  });

  const workspaceFs = new WorkspaceFS(cfg.workspaceRoot);
  const fileTools = createFileTools(workspaceFs);
  const auditLogger = new AuditLogger(cfg.dataDir);
  const approvalManager = new ApprovalManager();

  const mailConfigured = Boolean(cfg.mail.user && cfg.mail.pass);
  const smtpTransport = mailConfigured
    ? nodemailer.createTransport({
        host: cfg.mail.smtp.host,
        port: cfg.mail.smtp.port,
        secure: cfg.mail.smtp.secure,
        auth: { user: cfg.mail.user, pass: cfg.mail.pass },
      })
    : null;

  const schedulerEngine = new SchedulerEngine(cfg.dataDir);
  const executor = createSchedulerExecutor({
    cfg,
    fileTools,
    approvalManager,
    auditLogger,
    convStore,
    agents,
    memoryEngine,
    mailer: smtpTransport,
  });
  const schedulerRunner = new SchedulerRunner(schedulerEngine, executor);
  // Loads tasks.json; tasks with an invalid cron are logged and skipped, not fatal.
  await schedulerRunner.start();

  const server = createHttpServer(cfg, convStore, agents, memoryEngine, {
    fileTools,
    auditLogger,
    approvalManager,
    schedulerEngine,
    schedulerRunner,
  });
  await startHttpServer(server, cfg.port, cfg.host);

  console.log(`[EveryBot] HTTP server listening on http://${cfg.host}:${cfg.port}`);
  if (cfg.host !== "127.0.0.1" && cfg.host !== "localhost") {
    console.warn("[EveryBot] WARNING: the API has no authentication; only expose it on trusted networks.");
  }

  const processedStore = new ProcessedStore(cfg.dataDir);
  const emailChannel = new EmailChannel(cfg, agents, convStore, processedStore, memoryEngine);
  await emailChannel.start();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[EveryBot] ${signal} received, shutting down`);
    schedulerRunner.stop();
    await emailChannel.stop();
    server.close();
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown(signal));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

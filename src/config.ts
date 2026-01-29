import path from "node:path";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v == null || v === "") throw new Error(`Missing env: ${name}`);
  return v;
}

function envOptional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid int env: ${name}`);
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export type AppConfig = {
  dataDir: string;
  workspaceRoot: string;
  pollIntervalMs: number;
  defaultAgent: string;
  port: number;
  mail: {
    user: string;
    pass: string;
    imap: { host: string; port: number; secure: boolean };
    smtp: { host: string; port: number; secure: boolean };
  };
  llm: {
    baseUrl: string;
    apiKey: string;
    models: {
      default: string;
      files: string;
      scheduler: string;
      memorySummary: string;
      memoryFacts: string;
    };
  };
};

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(envOptional("DATA_DIR", "./data"));
  const workspaceRoot = path.join(dataDir, "workspace");

  return {
    dataDir,
    workspaceRoot,
    pollIntervalMs: envInt("POLL_INTERVAL_MS", 15000),
    defaultAgent: envOptional("DEFAULT_AGENT", "default"),
    port: envInt("PORT", 3000),
    mail: {
      user: envOptional("MAIL_USER", ""),
      pass: envOptional("MAIL_PASS", ""),
      imap: {
        host: envOptional("IMAP_HOST", "imap.qq.com"),
        port: envInt("IMAP_PORT", 993),
        secure: envBool("IMAP_SECURE", true),
      },
      smtp: {
        host: envOptional("SMTP_HOST", "smtp.qq.com"),
        port: envInt("SMTP_PORT", 465),
        secure: envBool("SMTP_SECURE", true),
      },
    },
    llm: {
      baseUrl: envOptional("SILICONFLOW_BASE_URL", "https://api.siliconflow.com/v1"),
      apiKey: envOptional("SILICONFLOW_API_KEY", ""),
      models: {
        default: envOptional("MODEL_DEFAULT", "deepseek-ai/DeepSeek-V3"),
        files: envOptional("MODEL_FILES", envOptional("MODEL_DEFAULT", "deepseek-ai/DeepSeek-V3")),
        scheduler: envOptional("MODEL_SCHEDULER", envOptional("MODEL_DEFAULT", "deepseek-ai/DeepSeek-V3")),
        memorySummary: envOptional("MODEL_MEMORY_SUMMARY", envOptional("MODEL_DEFAULT", "deepseek-ai/DeepSeek-V3")),
        memoryFacts: envOptional("MODEL_MEMORY_FACTS", envOptional("MODEL_DEFAULT", "deepseek-ai/DeepSeek-V3")),
      },
    },
  };
}

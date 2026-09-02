import path from "node:path";
import { parseAddressList } from "./core/allowlist.js";

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
  /** Interface the HTTP server binds to. Defaults to loopback: the API has no authentication. */
  host: string;
  port: number;
  /** Exact origin allowed to call the API cross-origin, or null to send no CORS headers at all. */
  allowedOrigin: string | null;
  mail: {
    user: string;
    pass: string;
    /** Addresses scheduled tasks may mail; empty means "only MAIL_USER itself". */
    allowedRecipients: string[];
    imap: { host: string; port: number; secure: boolean };
    smtp: { host: string; port: number; secure: boolean };
  };
  llm: {
    baseUrl: string;
    apiKey: string;
    /** Per-attempt HTTP timeout for LLM calls, in milliseconds. */
    timeoutMs: number;
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
  const defaultModel = envOptional("MODEL_DEFAULT", "deepseek-ai/DeepSeek-V3");

  return {
    dataDir,
    workspaceRoot,
    pollIntervalMs: envInt("POLL_INTERVAL_MS", 15000),
    defaultAgent: envOptional("DEFAULT_AGENT", "default"),
    host: envOptional("HOST", "127.0.0.1"),
    port: envInt("PORT", 3000),
    allowedOrigin: envOptional("ALLOWED_ORIGIN", "").trim() || null,
    mail: {
      user: envOptional("MAIL_USER", ""),
      pass: envOptional("MAIL_PASS", ""),
      allowedRecipients: parseAddressList(process.env.MAIL_ALLOWED_RECIPIENTS),
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
      // Generic names first; the SILICONFLOW_* names stay supported for existing setups.
      baseUrl: envOptional("LLM_BASE_URL", envOptional("SILICONFLOW_BASE_URL", "https://api.siliconflow.com/v1")),
      apiKey: envOptional("LLM_API_KEY", envOptional("SILICONFLOW_API_KEY", "")),
      timeoutMs: envInt("LLM_TIMEOUT_MS", 60_000),
      models: {
        default: defaultModel,
        files: envOptional("MODEL_FILES", defaultModel),
        scheduler: envOptional("MODEL_SCHEDULER", defaultModel),
        memorySummary: envOptional("MODEL_MEMORY_SUMMARY", defaultModel),
        memoryFacts: envOptional("MODEL_MEMORY_FACTS", defaultModel),
      },
    },
  };
}

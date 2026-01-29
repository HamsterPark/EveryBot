import fs from "node:fs/promises";
import path from "node:path";

export type AuditEntry = {
  at: string;
  tool: string;
  args: unknown;
  result: "ok" | "error" | "pending";
  detail?: string;
};

export class AuditLogger {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "audit.jsonl");
  }

  async log(entry: Omit<AuditEntry, "at">): Promise<void> {
    const full: AuditEntry = { ...entry, at: new Date().toISOString() };
    await fs.appendFile(this.filePath, JSON.stringify(full) + "\n", "utf-8");
  }
}

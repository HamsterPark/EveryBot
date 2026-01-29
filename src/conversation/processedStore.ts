import fs from "node:fs/promises";
import path from "node:path";

export class ProcessedStore {
  private seen = new Set<string>();
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "inbox_processed.jsonl");
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as { key?: string };
          if (obj && typeof obj.key === "string") this.seen.add(obj.key);
        } catch {
          // skip malformed
        }
      }
    } catch {
      // first run
    }
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  async add(key: string): Promise<void> {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    await fs.appendFile(
      this.filePath,
      JSON.stringify({ key, at: new Date().toISOString() }) + "\n",
      "utf-8"
    );
  }
}

import fs from "node:fs/promises";
import path from "node:path";
import type { LLMProvider } from "../core/llmProvider.js";
import type { ConversationStore } from "../conversation/store.js";
import type { ThreadItem } from "../conversation/store.js";

export type MemoryPack = {
  summary: string;
  facts: Record<string, unknown>;
  recentTurns: Array<{ role: "user" | "bot"; text: string }>;
};

export class MemoryEngine {
  constructor(
    private dataDir: string,
    private convStore: ConversationStore,
    private provider: LLMProvider | null,
    private models: { summary: string; facts: string }
  ) {}

  private convDir(convId: string): string {
    return path.join(this.dataDir, "conv", convId);
  }

  private summaryPath(convId: string): string {
    return path.join(this.convDir(convId), "summary.md");
  }

  private factsPath(convId: string): string {
    return path.join(this.convDir(convId), "facts.json");
  }

  async readSummary(convId: string): Promise<string> {
    try {
      return await fs.readFile(this.summaryPath(convId), "utf-8");
    } catch {
      return "";
    }
  }

  async writeSummary(convId: string, summary: string): Promise<void> {
    await fs.mkdir(this.convDir(convId), { recursive: true });
    const trimmed = (summary ?? "").trim().slice(0, 6000);
    await fs.writeFile(this.summaryPath(convId), trimmed + "\n", "utf-8");
  }

  async readFacts(convId: string): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.readFile(this.factsPath(convId), "utf-8");
      const obj = JSON.parse(raw) as unknown;
      return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  async writeFacts(convId: string, facts: Record<string, unknown>): Promise<void> {
    await fs.mkdir(this.convDir(convId), { recursive: true });
    await fs.writeFile(this.factsPath(convId), JSON.stringify(facts ?? {}, null, 2), "utf-8");
  }

  async buildMemoryPack(convId: string, recentN = 10): Promise<MemoryPack> {
    const [summary, facts, thread] = await Promise.all([
      this.readSummary(convId),
      this.readFacts(convId),
      this.convStore.getThread(convId, recentN),
    ]);

    const recentTurns = thread.map((t) => ({ role: t.role, text: t.text }));

    return { summary, facts, recentTurns };
  }

  async afterReply(convId: string, newTurns: ThreadItem[]): Promise<void> {
    if (!newTurns.length) return;

    const [oldSummary, oldFacts] = await Promise.all([
      this.readSummary(convId),
      this.readFacts(convId),
    ]);

    const delta = newTurns.map((t) => `${t.role.toUpperCase()}: ${t.text}`).join("\n\n");

    if (this.provider) {
      const newSummary = await this.updateSummaryWithLLM(oldSummary, delta);
      await this.writeSummary(convId, newSummary);
      const newFacts = await this.updateFactsWithLLM(oldFacts, delta);
      await this.writeFacts(convId, newFacts);
    } else {
      const newSummary = (oldSummary ? oldSummary + "\n\n" : "") + delta;
      await this.writeSummary(convId, newSummary.slice(0, 6000));
    }
  }

  private async updateSummaryWithLLM(oldSummary: string, delta: string): Promise<string> {
    if (!this.provider) return oldSummary;
    const sys = [
      "You are a memory summarization engine.",
      "Maintain a running, compact summary of the conversation.",
      "Rules: Keep it concise (<= 2500 characters). Preserve stable facts, decisions. Output ONLY markdown text (no code fences).",
    ].join("\n");

    const user = [
      "### Existing summary",
      oldSummary?.trim() || "(empty)",
      "",
      "### New turns to incorporate",
      delta,
      "",
      "### Updated summary (markdown only)",
    ].join("\n");

    const res = await this.provider.chat({
      model: this.models.summary,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: 700,
    });

    return res.text;
  }

  private async updateFactsWithLLM(
    oldFacts: Record<string, unknown>,
    delta: string
  ): Promise<Record<string, unknown>> {
    if (!this.provider) return oldFacts;

    const sys = [
      "You are a conversation fact extractor.",
      "Update the existing facts JSON using the new turns. Output STRICT JSON only (no markdown).",
    ].join("\n");

    const user = [
      "Existing facts JSON:",
      JSON.stringify(oldFacts ?? {}, null, 2),
      "",
      "New turns:",
      delta,
      "",
      "Return updated facts JSON only:",
    ].join("\n");

    const res = await this.provider.chat({
      model: this.models.facts,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: 700,
    });

    try {
      const obj = JSON.parse(res.text) as unknown;
      return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : oldFacts;
    } catch {
      return oldFacts;
    }
  }
}

import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../core/atomicWrite.js";
import type { LLMProvider } from "../core/llmProvider.js";
import type { MemoryPack } from "../core/agents.js";
import type { ConversationStore, ThreadItem } from "../conversation/store.js";
import { assertValidId } from "../conversation/ids.js";

export type { MemoryPack };

export type MemoryLogger = { warn(message: string): void };

const SUMMARY_MAX_CHARS = 6000;

/**
 * Pull a JSON object out of an LLM reply. Models routinely wrap JSON in ```json fences
 * or add a sentence of prose, so try the fenced block, the raw text, and the outermost
 * {...} span before giving up.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  candidates.push(text);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const obj: unknown = JSON.parse(candidate.trim());
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Per-conversation long-term memory: a rolling markdown summary plus a JSON facts
 * object, both stored next to the thread. With a provider the LLM maintains them;
 * without one the raw turns are appended so nothing is lost.
 */
export class MemoryEngine {
  constructor(
    private dataDir: string,
    private convStore: ConversationStore,
    private provider: LLMProvider | null,
    private models: { summary: string; facts: string },
    private logger: MemoryLogger = console
  ) {}

  private convDir(convId: string): string {
    return path.join(this.dataDir, "conv", assertValidId(convId, "conversation id"));
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
    const trimmed = (summary ?? "").trim().slice(0, SUMMARY_MAX_CHARS);
    await writeFileAtomic(this.summaryPath(convId), trimmed + "\n");
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
    await writeFileAtomic(this.factsPath(convId), JSON.stringify(facts ?? {}, null, 2));
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

  /**
   * Digest freshly exchanged turns into the summary and facts. Never throws: by the time
   * this runs the reply has already been delivered, so a memory failure is logged only.
   */
  async afterReply(convId: string, newTurns: ThreadItem[]): Promise<void> {
    if (!newTurns.length) return;

    try {
      const [oldSummary, oldFacts] = await Promise.all([this.readSummary(convId), this.readFacts(convId)]);
      const delta = newTurns.map((t) => `${t.role.toUpperCase()}: ${t.text}`).join("\n\n");

      if (this.provider) {
        const [newSummary, newFacts] = await Promise.all([
          this.updateSummaryWithLLM(oldSummary, delta),
          this.updateFactsWithLLM(oldFacts, delta),
        ]);
        await Promise.all([this.writeSummary(convId, newSummary), this.writeFacts(convId, newFacts)]);
      } else {
        // No LLM: append the raw turns and keep the most recent part under the cap.
        const combined = (oldSummary.trim() ? oldSummary.trim() + "\n\n" : "") + delta;
        await this.writeSummary(convId, combined.slice(-SUMMARY_MAX_CHARS));
      }
    } catch (e) {
      this.logger.warn(`[memory] update failed for ${convId}: ${e instanceof Error ? e.message : String(e)}`);
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

    return res.text.trim() || oldSummary;
  }

  private async updateFactsWithLLM(oldFacts: Record<string, unknown>, delta: string): Promise<Record<string, unknown>> {
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

    return extractJsonObject(res.text) ?? oldFacts;
  }
}

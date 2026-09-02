import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryEngine, extractJsonObject } from "./memoryEngine.js";
import { ConversationStore } from "../conversation/store.js";
import type { LLMProvider, ChatRequest } from "../core/llmProvider.js";

describe("extractJsonObject", () => {
  it("parses plain, fenced and prose-wrapped JSON objects", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('```json\n{"name": "Ann"}\n```')).toEqual({ name: "Ann" });
    expect(extractJsonObject('```\n{"x": [1,2]}\n```')).toEqual({ x: [1, 2] });
    expect(extractJsonObject('Here is the updated JSON:\n{"city": "Shenzhen"}\nDone.')).toEqual({ city: "Shenzhen" });
  });

  it("returns null for arrays, scalars and garbage", () => {
    expect(extractJsonObject("[1,2]")).toBeNull();
    expect(extractJsonObject("42")).toBeNull();
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject("")).toBeNull();
  });
});

describe("MemoryEngine", () => {
  let dir: string;
  let convStore: ConversationStore;
  const logger = { warn: vi.fn() };
  const models = { summary: "summary-model", facts: "facts-model" };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "everybot-memory-"));
    convStore = new ConversationStore(dir);
    logger.warn.mockReset();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const turns = [
    { role: "user" as const, text: "My name is Ann and I live in Shenzhen.", at: "t1" },
    { role: "bot" as const, text: "Nice to meet you, Ann.", at: "t2" },
  ];

  it("updates summary and facts in parallel, tolerating ```json fences", async () => {
    const calls: ChatRequest[] = [];
    const provider: LLMProvider = {
      async chat(req) {
        calls.push(req);
        if (req.model === "facts-model") return { text: '```json\n{"name": "Ann", "city": "Shenzhen"}\n```' };
        return { text: "Ann lives in Shenzhen." };
      },
    };
    const engine = new MemoryEngine(dir, convStore, provider, models, logger);
    const meta = await convStore.createConversation("default");

    await engine.afterReply(meta.convId, turns);

    expect(calls.map((c) => c.model).sort()).toEqual(["facts-model", "summary-model"]);
    expect(await engine.readFacts(meta.convId)).toEqual({ name: "Ann", city: "Shenzhen" });
    expect(await engine.readSummary(meta.convId)).toBe("Ann lives in Shenzhen.\n");

    const pack = await engine.buildMemoryPack(meta.convId);
    expect(pack.summary).toBe("Ann lives in Shenzhen.\n");
    expect(pack.facts).toEqual({ name: "Ann", city: "Shenzhen" });
  });

  it("keeps the previous facts when the model returns something unparsable", async () => {
    const provider: LLMProvider = {
      async chat(req) {
        return { text: req.model === "facts-model" ? "Sorry, I cannot do that." : "summary" };
      },
    };
    const engine = new MemoryEngine(dir, convStore, provider, models, logger);
    const meta = await convStore.createConversation("default");
    await engine.writeFacts(meta.convId, { keep: true });

    await engine.afterReply(meta.convId, turns);
    expect(await engine.readFacts(meta.convId)).toEqual({ keep: true });
  });

  it("logs instead of throwing when the provider fails", async () => {
    const provider: LLMProvider = {
      async chat() {
        throw new Error("LLM HTTP 500");
      },
    };
    const engine = new MemoryEngine(dir, convStore, provider, models, logger);
    const meta = await convStore.createConversation("default");
    await engine.writeFacts(meta.convId, { keep: true });

    await expect(engine.afterReply(meta.convId, turns)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/memory.*LLM HTTP 500/));
    expect(await engine.readFacts(meta.convId)).toEqual({ keep: true });
  });

  it("without a provider appends raw turns and keeps the newest text under the cap", async () => {
    const engine = new MemoryEngine(dir, convStore, null, models, logger);
    const meta = await convStore.createConversation("default");
    await engine.writeSummary(meta.convId, "old ".repeat(1500)); // 6000 chars, already at the cap

    await engine.afterReply(meta.convId, turns);
    const summary = await engine.readSummary(meta.convId);
    expect(summary.length).toBeLessThanOrEqual(6001);
    expect(summary).toContain("USER: My name is Ann");
    expect(summary).toContain("BOT: Nice to meet you, Ann.");
  });

  it("buildMemoryPack returns only the most recent turns", async () => {
    const engine = new MemoryEngine(dir, convStore, null, models, logger);
    const meta = await convStore.createConversation("default");
    for (let i = 0; i < 6; i++) {
      await convStore.append(meta.convId, { role: i % 2 ? "bot" : "user", text: `t${i}`, at: "x" });
    }
    const pack = await engine.buildMemoryPack(meta.convId, 4);
    expect(pack.recentTurns.map((t) => t.text)).toEqual(["t2", "t3", "t4", "t5"]);
  });
});

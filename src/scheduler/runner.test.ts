import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchedulerEngine, type Task } from "./schedulerEngine.js";
import { SchedulerRunner, type SchedulerExecutor } from "./runner.js";

const chat: Task["action"] = { type: "runChat", promptTemplate: "tick" };

function makeExecutor(): SchedulerExecutor & { runChat: ReturnType<typeof vi.fn> } {
  return {
    sendMessage: vi.fn(async () => {}),
    runTool: vi.fn(async () => ({ ok: true })),
    runChat: vi.fn(async () => "reply"),
  };
}

describe("SchedulerRunner", () => {
  let dir: string;
  let engine: SchedulerEngine;
  const logger = { warn: vi.fn(), error: vi.fn() };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "everybot-runner-"));
    engine = new SchedulerEngine(dir);
    logger.warn.mockReset();
    logger.error.mockReset();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("skips a task with an invalid cron instead of crashing startup", async () => {
    await engine.addTask({ id: "bad", cron: "not a cron", action: chat, enabled: true });
    await engine.addTask({ id: "good", cron: "0 0 1 1 *", action: chat, enabled: true });
    await engine.addTask({ id: "off", cron: "0 0 1 1 *", action: chat, enabled: false });

    const runner = new SchedulerRunner(engine, makeExecutor(), logger);
    await runner.start();
    try {
      expect(runner.scheduledTaskIds()).toEqual(["good"]);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0][0]).toMatch(/task bad not scheduled/);
    } finally {
      runner.stop();
    }
  });

  it("runNow executes the action with the task id and records the run", async () => {
    await engine.addTask({ id: "job", cron: "0 0 1 1 *", action: chat, enabled: true });
    const executor = makeExecutor();
    const runner = new SchedulerRunner(engine, executor, logger);
    await runner.start();
    try {
      expect(await runner.runNow("job")).toEqual({ ok: true });
      expect(executor.runChat).toHaveBeenCalledWith("tick", { taskId: "job" });
      expect(engine.getTask("job")?.lastRun).toBeDefined();
      const runs = await fs.readFile(path.join(dir, "runs.jsonl"), "utf-8");
      expect(JSON.parse(runs.trim())).toMatchObject({ taskId: "job", ok: true });
      expect(await runner.runNow("missing")).toBeNull();
    } finally {
      runner.stop();
    }
  });

  it("records a failed run without throwing", async () => {
    await engine.addTask({ id: "job", cron: "0 0 1 1 *", action: chat, enabled: true });
    const executor = makeExecutor();
    executor.runChat.mockRejectedValueOnce(new Error("LLM down"));
    const runner = new SchedulerRunner(engine, executor, logger);
    await runner.start();
    try {
      expect(await runner.runNow("job")).toEqual({ ok: false, detail: "LLM down" });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const runs = await fs.readFile(path.join(dir, "runs.jsonl"), "utf-8");
      expect(JSON.parse(runs.trim())).toMatchObject({ taskId: "job", ok: false, detail: "LLM down" });
    } finally {
      runner.stop();
    }
  });

  it("reload picks up tasks added after start", async () => {
    const runner = new SchedulerRunner(engine, makeExecutor(), logger);
    await runner.start();
    try {
      expect(runner.scheduledTaskIds()).toEqual([]);
      await engine.addTask({ id: "later", cron: "0 0 1 1 *", action: chat, enabled: true });
      await runner.reload();
      expect(runner.scheduledTaskIds()).toEqual(["later"]);
      await engine.removeTask("later");
      await runner.reload();
      expect(runner.scheduledTaskIds()).toEqual([]);
    } finally {
      runner.stop();
    }
  });

  it("fires a scheduled job when its cron time arrives", async () => {
    // Real timers on purpose: croner's scheduling does not cooperate with fake clocks.
    await engine.addTask({ id: "every-second", cron: "* * * * * *", action: chat, enabled: true });
    const executor = makeExecutor();
    const runner = new SchedulerRunner(engine, executor, logger);
    await runner.start();
    try {
      const deadline = Date.now() + 3000;
      while (executor.runChat.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(executor.runChat).toHaveBeenCalledWith("tick", { taskId: "every-second" });
    } finally {
      runner.stop();
    }
  }, 6000);
});

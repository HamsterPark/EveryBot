import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchedulerEngine, DuplicateTaskError, type Task } from "./schedulerEngine.js";

const action: Task["action"] = { type: "runChat", promptTemplate: "hello" };

describe("SchedulerEngine", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "everybot-sched-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("starts empty when tasks.json does not exist", async () => {
    const engine = new SchedulerEngine(dir);
    await engine.load();
    expect(engine.getTasks()).toEqual([]);
  });

  it("persists tasks and reloads them", async () => {
    const engine = new SchedulerEngine(dir);
    await engine.load();
    const t = await engine.addTask({ id: "t1", cron: "* * * * *", action, enabled: true });
    expect(t.createdAt).toBeDefined();

    const again = new SchedulerEngine(dir);
    await again.load();
    expect(again.getTasks().map((x) => x.id)).toEqual(["t1"]);
    expect(again.getTask("t1")?.action).toEqual(action);
  });

  it("rejects duplicate ids", async () => {
    const engine = new SchedulerEngine(dir);
    await engine.addTask({ id: "dup", cron: "* * * * *", action, enabled: true });
    await expect(engine.addTask({ id: "dup", cron: "* * * * *", action, enabled: true })).rejects.toThrow(
      DuplicateTaskError
    );
  });

  it("removes tasks and reports whether anything was removed", async () => {
    const engine = new SchedulerEngine(dir);
    await engine.addTask({ id: "gone", cron: "* * * * *", action, enabled: true });
    expect(await engine.removeTask("gone")).toBe(true);
    expect(await engine.removeTask("gone")).toBe(false);
    const again = new SchedulerEngine(dir);
    await again.load();
    expect(again.getTasks()).toEqual([]);
  });

  it("refuses to load a corrupt tasks.json instead of silently discarding tasks", async () => {
    await fs.writeFile(path.join(dir, "tasks.json"), "{ this is not json", "utf-8");
    const engine = new SchedulerEngine(dir);
    await expect(engine.load()).rejects.toThrow(/Cannot parse/);

    await fs.writeFile(path.join(dir, "tasks.json"), JSON.stringify({ nope: [] }), "utf-8");
    await expect(engine.load()).rejects.toThrow(/expected/);
  });

  it("records runs and lastRun", async () => {
    const engine = new SchedulerEngine(dir);
    await engine.addTask({ id: "r", cron: "* * * * *", action, enabled: true });
    await engine.setLastRun("r", "2026-01-01T00:00:00.000Z");
    await engine.appendRun({ taskId: "r", at: "2026-01-01T00:00:00.000Z", ok: true });
    expect(engine.getTask("r")?.lastRun).toBe("2026-01-01T00:00:00.000Z");
    const runs = await fs.readFile(path.join(dir, "runs.jsonl"), "utf-8");
    expect(JSON.parse(runs.trim())).toEqual({ taskId: "r", at: "2026-01-01T00:00:00.000Z", ok: true });
  });
});

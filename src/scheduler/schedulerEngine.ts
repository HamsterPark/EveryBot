import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../core/atomicWrite.js";

export type TaskAction =
  | { type: "sendMessage"; channel: string; target?: string; textTemplate: string }
  | { type: "runTool"; toolName: string; args: Record<string, unknown> }
  | { type: "runChat"; promptTemplate: string };

export type Task = {
  id: string;
  cron: string;
  timezone?: string;
  action: TaskAction;
  enabled: boolean;
  lastRun?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type TasksFile = {
  tasks: Task[];
};

export type RunEntry = { taskId: string; at: string; ok: boolean; detail?: string };

export class DuplicateTaskError extends Error {
  constructor(id: string) {
    super(`Task already exists: ${id}`);
    this.name = "DuplicateTaskError";
  }
}

/** Persists scheduled tasks in data/tasks.json and appends run results to data/runs.jsonl. */
export class SchedulerEngine {
  private filePath: string;
  private runsPath: string;
  private tasks: Task[] = [];

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "tasks.json");
    this.runsPath = path.join(dataDir, "runs.jsonl");
  }

  /**
   * Load tasks.json. A missing file means "no tasks"; a corrupt file is an error rather
   * than silently starting with an empty list (which would lose every task on next save).
   */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.tasks = [];
        return;
      }
      throw e;
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Cannot parse ${this.filePath}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    const tasks = (data as Partial<TasksFile> | null)?.tasks;
    if (!Array.isArray(tasks)) throw new Error(`Invalid tasks file ${this.filePath}: expected {"tasks": [...]}`);
    this.tasks = tasks;
  }

  async save(): Promise<void> {
    await writeFileAtomic(this.filePath, JSON.stringify({ tasks: this.tasks }, null, 2));
  }

  getTasks(): Task[] {
    return [...this.tasks];
  }

  getTask(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  async addTask(task: Omit<Task, "createdAt" | "updatedAt">): Promise<Task> {
    if (this.tasks.some((t) => t.id === task.id)) throw new DuplicateTaskError(task.id);
    const now = new Date().toISOString();
    const t: Task = {
      ...task,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.push(t);
    await this.save();
    return t;
  }

  async removeTask(id: string): Promise<boolean> {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    if (this.tasks.length === before) return false;
    await this.save();
    return true;
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<Task | null> {
    const i = this.tasks.findIndex((t) => t.id === id);
    if (i < 0) return null;
    this.tasks[i] = { ...this.tasks[i], ...patch, id, updatedAt: new Date().toISOString() };
    await this.save();
    return this.tasks[i];
  }

  async setLastRun(id: string, lastRun: string): Promise<void> {
    const i = this.tasks.findIndex((t) => t.id === id);
    if (i >= 0) {
      this.tasks[i].lastRun = lastRun;
      await this.save();
    }
  }

  async appendRun(entry: RunEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.runsPath), { recursive: true });
    await fs.appendFile(this.runsPath, JSON.stringify(entry) + "\n", "utf-8");
  }

  getEnabledTasks(): Task[] {
    return this.tasks.filter((t) => t.enabled);
  }
}

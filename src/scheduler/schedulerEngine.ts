import fs from "node:fs/promises";
import path from "node:path";

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

export class SchedulerEngine {
  private filePath: string;
  private runsPath: string;
  private tasks: Task[] = [];

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "tasks.json");
    this.runsPath = path.join(dataDir, "runs.jsonl");
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const data = JSON.parse(raw) as TasksFile;
      this.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    } catch {
      this.tasks = [];
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(
      this.filePath,
      JSON.stringify({ tasks: this.tasks }, null, 2),
      "utf-8"
    );
  }

  getTasks(): Task[] {
    return [...this.tasks];
  }

  async addTask(task: Omit<Task, "createdAt" | "updatedAt">): Promise<Task> {
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

  async updateTask(id: string, patch: Partial<Task>): Promise<Task | null> {
    const i = this.tasks.findIndex((t) => t.id === id);
    if (i < 0) return null;
    this.tasks[i] = { ...this.tasks[i], ...patch, updatedAt: new Date().toISOString() };
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

  async appendRun(entry: { taskId: string; at: string; ok: boolean; detail?: string }): Promise<void> {
    await fs.appendFile(
      this.runsPath,
      JSON.stringify(entry) + "\n",
      "utf-8"
    );
  }

  getEnabledTasks(): Task[] {
    return this.tasks.filter((t) => t.enabled);
  }
}

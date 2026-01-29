import { Cron } from "croner";
import type { SchedulerEngine, Task, TaskAction } from "./schedulerEngine.js";

export type SchedulerExecutor = {
  sendMessage(channel: string, target: string | undefined, text: string): Promise<void>;
  runTool(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  runChat(promptTemplate: string): Promise<string>;
};

export class SchedulerRunner {
  private jobs: Map<string, Cron> = new Map();

  constructor(
    private engine: SchedulerEngine,
    private executor: SchedulerExecutor
  ) {}

  async start(): Promise<void> {
    await this.engine.load();
    const tasks = this.engine.getEnabledTasks();
    for (const task of tasks) {
      this.scheduleTask(task);
    }
  }

  stop(): void {
    for (const job of this.jobs.values()) {
      job.stop();
    }
    this.jobs.clear();
  }

  private scheduleTask(task: Task): void {
    if (this.jobs.has(task.id)) {
      this.jobs.get(task.id)?.stop();
      this.jobs.delete(task.id);
    }

    const opts: { timezone?: string } = task.timezone ? { timezone: task.timezone } : {};
    const job = new Cron(task.cron, opts, async () => {
      await this.runTask(task);
    });
    this.jobs.set(task.id, job);
  }

  private async runTask(task: Task): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.executeAction(task.action);
      await this.engine.setLastRun(task.id, now);
      await this.engine.appendRun({ taskId: task.id, at: now, ok: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.engine.appendRun({ taskId: task.id, at: now, ok: false, detail: message });
    }
  }

  private async executeAction(action: TaskAction): Promise<void> {
    if (action.type === "sendMessage") {
      await this.executor.sendMessage(action.channel, action.target, action.textTemplate);
      return;
    }
    if (action.type === "runTool") {
      await this.executor.runTool(action.toolName, action.args);
      return;
    }
    if (action.type === "runChat") {
      await this.executor.runChat(action.promptTemplate);
      return;
    }
    throw new Error("Unknown action type");
  }

  async reload(): Promise<void> {
    this.stop();
    await this.start();
  }
}

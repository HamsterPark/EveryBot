import { Cron } from "croner";
import type { RunEntry, SchedulerEngine, Task } from "./schedulerEngine.js";

export type SchedulerExecutor = {
  sendMessage(channel: string, target: string | undefined, text: string): Promise<void>;
  runTool(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  runChat(promptTemplate: string, ctx: { taskId: string }): Promise<string>;
};

export type RunnerLogger = {
  warn(message: string): void;
  error(message: string): void;
};

export type RunResult = Pick<RunEntry, "ok" | "detail">;

/** Turns persisted tasks into croner jobs and records every execution. */
export class SchedulerRunner {
  private jobs: Map<string, Cron> = new Map();

  constructor(
    private engine: SchedulerEngine,
    private executor: SchedulerExecutor,
    private logger: RunnerLogger = console
  ) {}

  /** Load tasks from disk and schedule every enabled one. A task with an invalid cron is skipped, not fatal. */
  async start(): Promise<void> {
    await this.engine.load();
    for (const task of this.engine.getEnabledTasks()) {
      this.scheduleTask(task);
    }
  }

  stop(): void {
    for (const job of this.jobs.values()) {
      job.stop();
    }
    this.jobs.clear();
  }

  /** Re-read tasks.json and rebuild all jobs; called after tasks are added or removed. */
  async reload(): Promise<void> {
    this.stop();
    await this.start();
  }

  scheduledTaskIds(): string[] {
    return [...this.jobs.keys()];
  }

  /** Execute a task immediately, outside its schedule. Returns null when the task does not exist. */
  async runNow(taskId: string): Promise<RunResult | null> {
    const task = this.engine.getTask(taskId);
    if (!task) return null;
    return this.runTask(task);
  }

  private scheduleTask(task: Task): void {
    this.jobs.get(task.id)?.stop();
    this.jobs.delete(task.id);

    try {
      // protect: never start a run while the previous run of the same task is still going.
      const job = new Cron(task.cron, { ...(task.timezone ? { timezone: task.timezone } : {}), protect: true }, () => {
        void this.runTask(task);
      });
      this.jobs.set(task.id, job);
    } catch (e) {
      this.logger.error(`[scheduler] task ${task.id} not scheduled: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async runTask(task: Task): Promise<RunResult> {
    const now = new Date().toISOString();
    try {
      await this.executeAction(task);
      await this.engine.setLastRun(task.id, now);
      await this.engine.appendRun({ taskId: task.id, at: now, ok: true });
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`[scheduler] task ${task.id} failed: ${message}`);
      await this.engine.appendRun({ taskId: task.id, at: now, ok: false, detail: message });
      return { ok: false, detail: message };
    }
  }

  private async executeAction(task: Task): Promise<void> {
    const { action } = task;
    switch (action.type) {
      case "sendMessage":
        await this.executor.sendMessage(action.channel, action.target, action.textTemplate);
        return;
      case "runTool":
        await this.executor.runTool(action.toolName, action.args);
        return;
      case "runChat":
        await this.executor.runChat(action.promptTemplate, { taskId: task.id });
        return;
      default:
        throw new Error(`Unknown action type: ${(action as { type?: string }).type}`);
    }
  }
}

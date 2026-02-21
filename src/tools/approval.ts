import { randomUUID } from "node:crypto";

export type PendingTool = {
  id: string;
  tool: string;
  args: unknown;
  at: string;
};

export type ApprovalManagerListener = (id: string, approved: boolean) => void;

export class ApprovalManager {
  private pending = new Map<string, PendingTool>();
  private listeners: Array<(id: string, approved: boolean) => void> = [];

  add(tool: string, args: unknown): string {
    const id = randomUUID();
    this.pending.set(id, {
      id,
      tool,
      args,
      at: new Date().toISOString(),
    });
    return id;
  }

  get(id: string): PendingTool | undefined {
    return this.pending.get(id);
  }

  list(): PendingTool[] {
    return Array.from(this.pending.values());
  }

  /** Returns the pending item if found and removes it; caller can then execute. */
  approve(id: string): PendingTool | null {
    const p = this.pending.get(id);
    if (!p) return null;
    this.pending.delete(id);
    this.listeners.forEach((fn) => fn(id, true));
    return p;
  }

  reject(id: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    this.listeners.forEach((fn) => fn(id, false));
    return true;
  }

  onResolve(fn: ApprovalManagerListener): void {
    this.listeners.push(fn);
  }
}

import type { WorkspaceFS } from "../core/workspaceFs.js";

export type FileToolResult = { ok: true; data: string | string[] } | { ok: false; error: string };

export interface FileToolsApi {
  list(path: string): Promise<FileToolResult>;
  read(path: string, maxBytes?: number): Promise<FileToolResult>;
  write(path: string, content: string): Promise<FileToolResult>;
  delete(path: string): Promise<FileToolResult>;
}

export function createFileTools(workspaceFs: WorkspaceFS): FileToolsApi {
  return {
    async list(userPath: string): Promise<FileToolResult> {
      try {
        const entries = await workspaceFs.listDir(userPath || ".");
        return { ok: true, data: entries };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async read(userPath: string, maxBytes = 1_000_000): Promise<FileToolResult> {
      try {
        const text = await workspaceFs.readText(userPath, maxBytes);
        return { ok: true, data: text };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async write(userPath: string, content: string): Promise<FileToolResult> {
      try {
        await workspaceFs.writeText(userPath, content);
        return { ok: true, data: "written" };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async delete(userPath: string): Promise<FileToolResult> {
      try {
        await workspaceFs.remove(userPath);
        return { ok: true, data: "deleted" };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

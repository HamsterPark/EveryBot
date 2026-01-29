import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WorkspaceFS } from "./workspaceFs.js";

describe("WorkspaceFS", () => {
  let tmpDir: string;
  let ws: WorkspaceFS;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `everybot-workspacefs-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    ws = new WorkspaceFS(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("path escape", () => {
    it("rejects absolute path", async () => {
      const abs = process.platform === "win32" ? "C:\\Windows\\foo" : "/etc/passwd";
      await expect(ws.readText(abs)).rejects.toThrow("Absolute path not allowed");
    });

    it("rejects path with .. escaping workspace", async () => {
      await expect(ws.readText("../outside")).rejects.toThrow("Path escapes workspace");
      await expect(ws.readText("a/../../outside")).rejects.toThrow("Path escapes workspace");
    });

    it("rejects empty path", async () => {
      await expect(ws.readText("")).rejects.toThrow("Empty path");
      await expect(ws.readText("   ")).rejects.toThrow("Empty path");
    });

    it("rejects drive path on Windows-style input", async () => {
      await expect(ws.readText("C:foo")).rejects.toThrow("Drive path not allowed");
    });
  });

  describe("normal read/write/list/remove", () => {
    it("writes and reads text", async () => {
      await ws.writeText("foo.txt", "hello");
      expect(await ws.readText("foo.txt")).toBe("hello");
    });

    it("lists directory", async () => {
      await ws.writeText("a.txt", "a");
      await ws.writeText("sub/b.txt", "b");
      const list = await ws.listDir(".");
      expect(list.sort()).toEqual(["a.txt", "sub/"]);
    });

    it("listDir with subpath", async () => {
      await ws.writeText("sub/b.txt", "b");
      expect(await ws.listDir("sub")).toEqual(["b.txt"]);
    });

    it("removes file", async () => {
      await ws.writeText("gone.txt", "x");
      await ws.remove("gone.txt");
      await expect(ws.readText("gone.txt")).rejects.toThrow();
    });

    it("readText enforces maxBytes", async () => {
      const big = "x".repeat(2_000_000);
      await ws.writeText("big.txt", big);
      await expect(ws.readText("big.txt", 1_000_000)).rejects.toThrow("File too large");
    });
  });

  describe("symlink", () => {
    it("rejects symlink target if present", async () => {
      await ws.writeText("real.txt", "content");
      const realPath = path.join(tmpDir, "real.txt");
      const linkPath = path.join(tmpDir, "link.txt");
      try {
        await fs.symlink(realPath, linkPath);
      } catch {
        return; // skip if symlink not allowed (e.g. Windows without privilege)
      }
      await expect(ws.readText("link.txt")).rejects.toThrow("Symlink/junction");
      await fs.unlink(linkPath).catch(() => {});
    });
  });
});

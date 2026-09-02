import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WorkspaceFS } from "./workspaceFs.js";

/** Create a link; returns false where the platform/account does not allow it so the test can skip. */
async function tryLink(target: string, linkPath: string, type?: "file" | "dir" | "junction"): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}

describe("WorkspaceFS", () => {
  let tmpDir: string;
  let ws: WorkspaceFS;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "everybot-workspacefs-"));
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
      await expect(ws.readText("..")).rejects.toThrow("Path escapes workspace");
    });

    it("rejects empty path", async () => {
      await expect(ws.readText("")).rejects.toThrow("Empty path");
      await expect(ws.readText("   ")).rejects.toThrow("Empty path");
    });

    it("rejects drive-relative and UNC paths", async () => {
      await expect(ws.readText("C:foo")).rejects.toThrow("Drive path not allowed");
      await expect(ws.readText("//server/share")).rejects.toThrow(/UNC|Absolute/);
    });

    it("allows names that merely start with dots", async () => {
      await ws.writeText("..notes.txt", "x");
      expect(await ws.readText("..notes.txt")).toBe("x");
      expect(await ws.listDir(".")).toEqual(["..notes.txt"]);
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

  describe("workspace root", () => {
    it("refuses to remove the workspace root, however it is spelled", async () => {
      await ws.writeText("keep.txt", "x");
      await expect(ws.remove(".")).rejects.toThrow("workspace root");
      await expect(ws.remove("./")).rejects.toThrow("workspace root");
      await expect(ws.remove("sub/..")).rejects.toThrow("workspace root");
      expect(await ws.readText("keep.txt")).toBe("x");
    });
  });

  describe("symlinks", () => {
    it("rejects reading through a symlink", async (ctx) => {
      await ws.writeText("real.txt", "content");
      if (!(await tryLink(path.join(tmpDir, "real.txt"), path.join(tmpDir, "link.txt")))) ctx.skip();
      await expect(ws.readText("link.txt")).rejects.toThrow("Symlink/junction");
    });

    it("refuses to write through a symlink that points outside the workspace", async (ctx) => {
      const outside = path.join(os.tmpdir(), `everybot-outside-${process.pid}-${Date.now()}.txt`);
      await fs.writeFile(outside, "original", "utf-8");
      try {
        if (!(await tryLink(outside, path.join(tmpDir, "link.txt")))) ctx.skip();
        await expect(ws.writeText("link.txt", "pwned")).rejects.toThrow("Symlink/junction");
        expect(await fs.readFile(outside, "utf-8")).toBe("original");
      } finally {
        await fs.rm(outside, { force: true });
      }
    });

    it("refuses to list or write inside a linked directory", async (ctx) => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "everybot-outside-"));
      try {
        if (!(await tryLink(outsideDir, path.join(tmpDir, "linkdir"), "junction"))) ctx.skip();
        await expect(ws.listDir("linkdir")).rejects.toThrow("Symlink/junction");
        await expect(ws.writeText("linkdir/new.txt", "x")).rejects.toThrow("Symlink/junction");
        expect(await fs.readdir(outsideDir)).toEqual([]);
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });
});

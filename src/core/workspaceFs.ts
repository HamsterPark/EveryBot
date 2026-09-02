import path from "node:path";
import fs from "node:fs/promises";

export type FsMode = "read" | "write" | "list" | "delete";

async function lstatOrNull(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

/**
 * Sandboxed file access rooted at the workspace directory.
 *
 * Defence in depth, in order:
 *   1. reject absolute, drive-relative ("C:foo") and UNC paths outright;
 *   2. resolve and require the result to stay under the root (no "..");
 *   3. lstat every existing component from the root down to the target itself and
 *      refuse symlinks/junctions, so no fs call can follow a link out of the sandbox;
 *   4. never delete the root itself.
 */
export class WorkspaceFS {
  constructor(private workspaceRoot: string) {}

  private async assertNotLink(p: string): Promise<void> {
    const st = await fs.lstat(p);
    if (st.isSymbolicLink()) {
      throw new Error(`Symlink/junction is not allowed: ${p}`);
    }
    // No realpath comparison on purpose: on Windows os.tmpdir() and friends can be 8.3
    // short paths that realpath() expands, which would falsely reject ordinary
    // directories. lstat already catches the actual escape vector (links/junctions).
  }

  private async resolveInside(userPath: string, mode: FsMode): Promise<string> {
    if (!userPath || userPath.trim() === "") throw new Error("Empty path");

    if (path.win32.isAbsolute(userPath)) throw new Error("Absolute path not allowed");
    if (/^[a-zA-Z]:/.test(userPath)) throw new Error("Drive path not allowed");
    if (userPath.startsWith("\\\\") || userPath.startsWith("//")) throw new Error("UNC path not allowed");

    const root = path.resolve(this.workspaceRoot);
    const resolved = path.resolve(root, userPath);

    const rel = path.relative(root, resolved);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error("Path escapes workspace");
    }
    if (rel === "" && mode === "delete") throw new Error("Refusing to remove the workspace root");

    if (!(await lstatOrNull(root))) {
      await fs.mkdir(root, { recursive: true });
    }
    await this.assertNotLink(root);

    // Walk every existing component including the target itself (for every mode): a link
    // at the leaf would otherwise let writeFile() follow it to a file outside the sandbox.
    let cur = root;
    for (const part of rel.split(path.sep).filter(Boolean)) {
      cur = path.join(cur, part);
      if (!(await lstatOrNull(cur))) break;
      await this.assertNotLink(cur);
    }

    return resolved;
  }

  async readText(userPath: string, maxBytes = 1_000_000): Promise<string> {
    const p = await this.resolveInside(userPath, "read");
    const buf = await fs.readFile(p);
    if (buf.byteLength > maxBytes) throw new Error(`File too large: ${buf.byteLength} bytes`);
    return buf.toString("utf-8");
  }

  async writeText(userPath: string, content: string): Promise<void> {
    const p = await this.resolveInside(userPath, "write");
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, "utf-8");
  }

  async listDir(userPath: string = "."): Promise<string[]> {
    const p = await this.resolveInside(userPath, "list");
    const entries = await fs.readdir(p, { withFileTypes: true });
    return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  }

  async remove(userPath: string): Promise<void> {
    const p = await this.resolveInside(userPath, "delete");
    await fs.rm(p, { recursive: true, force: true });
  }
}

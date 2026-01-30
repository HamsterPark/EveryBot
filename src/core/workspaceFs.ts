import path from "node:path";
import fs from "node:fs/promises";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export class WorkspaceFS {
  constructor(private workspaceRoot: string) {}

  private async assertNotLinkOrReparse(p: string): Promise<void> {
    const st = await fs.lstat(p);

    if (st.isSymbolicLink()) {
      throw new Error(`Symlink/junction is not allowed: ${p}`);
    }

    // On Windows, skip realpath comparison: os.tmpdir() etc. can return short (8.3) paths,
    // and realpath() resolves to long form, so we would falsely reject normal directories.
    // Symlink/junction are already rejected by isSymbolicLink() above.
  }

  private async ensureInsideWorkspace(
    userPath: string,
    mode: "read" | "write" | "list" | "delete"
  ): Promise<string> {
    if (!userPath || userPath.trim() === "") throw new Error("Empty path");

    if (path.win32.isAbsolute(userPath)) throw new Error("Absolute path not allowed");
    if (/^[a-zA-Z]:/.test(userPath)) throw new Error("Drive path not allowed");
    if (userPath.startsWith("\\\\") || userPath.startsWith("//")) throw new Error("UNC path not allowed");

    const root = path.resolve(this.workspaceRoot);
    const resolved = path.resolve(root, userPath);

    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Path escapes workspace");
    }

    const targetToCheck = mode === "write" ? path.dirname(resolved) : resolved;

    if (!(await exists(root))) {
      await fs.mkdir(root, { recursive: true });
    }
    await this.assertNotLinkOrReparse(root);

    const relToCheck = path.relative(root, targetToCheck);
    const partsToCheck = relToCheck.split(path.sep).filter(Boolean);

    let cur = root;
    for (const part of partsToCheck) {
      cur = path.join(cur, part);

      if (!(await exists(cur))) {
        break;
      }
      await this.assertNotLinkOrReparse(cur);
    }

    return resolved;
  }

  async readText(userPath: string, maxBytes = 1_000_000): Promise<string> {
    const p = await this.ensureInsideWorkspace(userPath, "read");
    const buf = await fs.readFile(p);
    if (buf.byteLength > maxBytes) throw new Error(`File too large: ${buf.byteLength} bytes`);
    return buf.toString("utf-8");
  }

  async writeText(userPath: string, content: string): Promise<void> {
    const p = await this.ensureInsideWorkspace(userPath, "write");

    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, "utf-8");
  }

  async listDir(userPath: string = "."): Promise<string[]> {
    const p = await this.ensureInsideWorkspace(userPath, "list");
    const entries = await fs.readdir(p, { withFileTypes: true });
    return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  }

  async remove(userPath: string): Promise<void> {
    const p = await this.ensureInsideWorkspace(userPath, "delete");
    await fs.rm(p, { recursive: true, force: true });
  }
}

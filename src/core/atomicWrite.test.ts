import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "./atomicWrite.js";

describe("writeFileAtomic", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "everybot-atomic-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates missing parent directories and writes the content", async () => {
    const target = path.join(dir, "nested", "deeper", "file.json");
    await writeFileAtomic(target, '{"a":1}');
    expect(await fs.readFile(target, "utf-8")).toBe('{"a":1}');
  });

  it("replaces an existing file and leaves no temporary files behind", async () => {
    const target = path.join(dir, "file.json");
    await writeFileAtomic(target, "first");
    await writeFileAtomic(target, "second");
    expect(await fs.readFile(target, "utf-8")).toBe("second");
    expect(await fs.readdir(dir)).toEqual(["file.json"]);
  });

  it("cleans up the temporary file when the write cannot complete", async () => {
    // The target's parent is a *file*, so mkdir/rename must fail.
    const blocker = path.join(dir, "blocker");
    await fs.writeFile(blocker, "x");
    await expect(writeFileAtomic(path.join(blocker, "child.json"), "data")).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual(["blocker"]);
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const RENAME_RETRIES = 5;

/**
 * Write a file so readers never observe a half-written state: the content goes to a
 * temporary file in the same directory, which is then renamed over the target.
 * rename() replaces atomically on POSIX and NTFS. On Windows the rename can transiently
 * fail with EPERM/EBUSY while another process (indexer, antivirus) holds the target,
 * so it is retried a few times.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);

  try {
    await fs.writeFile(tmp, content, "utf-8");
    for (let attempt = 1; ; attempt++) {
      try {
        await fs.rename(tmp, filePath);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (attempt >= RENAME_RETRIES || (code !== "EPERM" && code !== "EBUSY")) throw e;
        await new Promise((r) => setTimeout(r, 10 * attempt));
      }
    }
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

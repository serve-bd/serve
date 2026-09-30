import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Writes a file in a directory containers may mount (a compose project), as a new file renamed
 * over the old one: a symlink a container planted at `file` is replaced, never written through.
 */
export async function replaceFile(file: string, content: string, mode = 0o644) {
  const tmp = path.join(path.dirname(file), `.serve-${crypto.randomBytes(8).toString("hex")}.tmp`);
  const handle = await fs.open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await handle.writeFile(content);
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file).catch(async (error) => {
    await fs.rm(tmp, { force: true });
    throw error;
  });
}

import {
  constants,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm
} from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export async function readJsonFile<T = unknown>(path: string): Promise<T> {
  const source = await readFile(path, "utf8");
  try {
    return JSON.parse(source) as T;
  } catch {
    throw new SyntaxError(`File is not valid JSON: ${path}`);
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function backupTimestamp(date: Date): string {
  const digits = (value: number): string => value.toString().padStart(2, "0");
  return [
    date.getFullYear(),
    digits(date.getMonth() + 1),
    digits(date.getDate()),
    "-",
    digits(date.getHours()),
    digits(date.getMinutes()),
    digits(date.getSeconds())
  ].join("");
}

export async function backupOnce(
  source: string,
  recordedBackup?: string
): Promise<string> {
  if (recordedBackup) return recordedBackup;

  const base = `${source}.backup-${backupTimestamp(new Date())}`;
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const destination = suffix === 0 ? base : `${base}-${suffix}`;
    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      return destination;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Unable to create a unique backup for ${source}`);
}

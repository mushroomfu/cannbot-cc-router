import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

async function sourceFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) return sourceFiles(join(directory, entry.name), relative);
    return entry.isFile() && entry.name.endsWith(".ts") ? [relative] : [];
  }));
  return nested.flat();
}

test("production source retains no shared CCR lifecycle or alternate AI client launch", async () => {
  const files = await sourceFiles(sourceRoot);
  const legacyModules = [
    "ccr-config.ts",
    "ccr-processes.ts",
    "ccr-v2-adapter.ts",
    "ccr-v3-adapter.ts",
    "ccr-v3-store.ts",
    "shim-main.ts"
  ];
  assert.deepEqual(files.filter((file) => legacyModules.includes(file)), []);

  const source = (await Promise.all(files.map(async (file) => readFile(join(sourceRoot, file), "utf8")))).join("\n");
  assert.doesNotMatch(source, /\brunCcrCode\b/);
  assert.doesNotMatch(source, /\bccr\s+code\b/i);
  assert.doesNotMatch(source, /\b(?:spawn|runAttached|runCaptured)\s*\(\s*["']codex["']/i);
});

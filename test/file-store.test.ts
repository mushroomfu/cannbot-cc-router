import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { backupOnce, readJsonFile, writeJsonAtomic } from "../src/file-store.js";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cannbot-cc-store-"));
}

test("writes JSON atomically and reads it back", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "nested", "config.json");

  await writeJsonAtomic(path, { model: "glm-5.2", enabled: true });

  assert.deepEqual(await readJsonFile(path), { model: "glm-5.2", enabled: true });
  assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
  assert.deepEqual((await readdir(join(directory, "nested"))).sort(), ["config.json"]);
});

test("malformed JSON is reported without modifying the source", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "config.json");
  await writeFile(path, "{broken", "utf8");

  await assert.rejects(readJsonFile(path), /valid JSON/);
  assert.equal(await readFile(path, "utf8"), "{broken");
});

test("creates only the first timestamped backup", async () => {
  const directory = await temporaryDirectory();
  const source = join(directory, "config.json");
  await writeFile(source, "original", "utf8");

  const first = await backupOnce(source);
  await writeFile(source, "changed", "utf8");
  const second = await backupOnce(source, first);

  assert.equal(second, first);
  assert.equal(await readFile(first, "utf8"), "original");
  assert.equal((await readdir(directory)).filter((name) => name.includes(".backup-")).length, 1);
});

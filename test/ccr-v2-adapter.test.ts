import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CcrV2Adapter } from "../src/ccr-v2-adapter.js";
import { readJsonFile, writeJsonAtomic } from "../src/file-store.js";
import { resolvePaths } from "../src/paths.js";

const reconcileOptions = {
  shimPort: 8787,
  localSecret: "local-secret",
  model: "glm-5.2",
  models: ["glm-5.2"],
  setDefault: true
};

test("v2 adapter reconciles JSON and returns its configured endpoint", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-ccr-v2-"));
  const paths = resolvePaths({ home, platform: "linux" });
  await writeJsonAtomic(paths.ccrV2Config, {
    PORT: 4567,
    APIKEY: "ccr-local-key",
    Providers: [{ name: "other", models: [] }],
    Router: {}
  });
  const adapter = new CcrV2Adapter(paths);

  await adapter.reconcile(reconcileOptions);

  assert.deepEqual(await adapter.loadConnection(), {
    major: 2,
    baseUrl: "http://127.0.0.1:4567",
    apiKey: "ccr-local-key"
  });
  const stored = await readJsonFile<{ Providers: Array<{ name: string }> }>(paths.ccrV2Config);
  assert.deepEqual(stored.Providers.map((provider) => provider.name), ["other", "cannbot"]);
});
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CcrV2Adapter } from "../src/ccr-v2-adapter.js";
import { CcrV3Adapter } from "../src/ccr-v3-adapter.js";
import { writeJsonAtomic } from "../src/file-store.js";
import { resolvePaths } from "../src/paths.js";
import { loadShimOptions } from "../src/shim-main.js";

test("loads model catalog and local CCR connection without Cannbot credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-shim-options-"));
  const paths = resolvePaths({ home, platform: "linux" });
  await writeJsonAtomic(paths.projectConfig, {
    model: "glm-5.2",
    models: ["deepseek-v4-pro", "glm-5.2"],
    shimHost: "127.0.0.1",
    shimPort: 8787,
    localSecret: "shim-local-secret",
    proxy: "auto"
  });
  await writeJsonAtomic(paths.ccrConfig, {
    PORT: 4567,
    APIKEY: "ccr-local-key",
    Providers: [],
    Router: {}
  });

  const options = await loadShimOptions(paths.projectConfig, { ccr: new CcrV2Adapter(paths) });
  assert.deepEqual(options.models, ["deepseek-v4-pro", "glm-5.2"]);
  assert.equal(options.ccrUrl, "http://127.0.0.1:4567");
  assert.equal(options.ccrApiKey, "ccr-local-key");
  assert.equal(options.localSecret, "shim-local-secret");
  assert.equal(options.port, 8787);
});

test("loads the CCR v3 SQLite connection for the shim", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-shim-options-v3-"));
  const paths = resolvePaths({ home, platform: "linux" });
  await writeJsonAtomic(paths.projectConfig, {
    model: "glm-5.2", models: ["glm-5.2"], shimHost: "127.0.0.1",
    shimPort: 8787, localSecret: "shim-local-secret", proxy: "auto"
  });
  const ccr = new CcrV3Adapter({
    paths,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    health: async () => false
  });
  await ccr.reconcile({
    shimPort: 8787, localSecret: "shim-local-secret", model: "glm-5.2",
    models: ["glm-5.2"], setDefault: true
  });

  const options = await loadShimOptions(paths.projectConfig, { ccr });
  assert.equal(options.ccrUrl, "http://127.0.0.1:3456");
  assert.equal(options.ccrApiKey, "shim-local-secret");
});
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

  const options = await loadShimOptions(paths.projectConfig);
  assert.deepEqual(options.models, ["deepseek-v4-pro", "glm-5.2"]);
  assert.equal(options.ccrUrl, "http://127.0.0.1:4567");
  assert.equal(options.ccrApiKey, "ccr-local-key");
  assert.equal(options.localSecret, "shim-local-secret");
  assert.equal(options.port, 8787);
});

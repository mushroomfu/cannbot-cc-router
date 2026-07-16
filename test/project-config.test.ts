import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadOrCreateProjectConfig } from "../src/project-config.js";
import { resolvePaths } from "../src/paths.js";

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

test("bootstraps only project-owned configuration without touching shared CCR", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-project-bootstrap-"));
  const paths = resolvePaths({ home, platform: "win32", env: { APPDATA: join(home, "shared-appdata") } });
  const config = await loadOrCreateProjectConfig(paths, {
    listModels: async () => ["deepseek-v4-pro", "glm-5.2"],
    secret: () => "project-placeholder-secret"
  });
  assert.equal(config.model, "glm-5.2");
  assert.deepEqual(config.models, ["deepseek-v4-pro", "glm-5.2"]);
  assert.equal(config.proxy, "auto");
  assert.equal(await exists(paths.projectConfig), true);
  assert.equal(await exists(join(home, ".claude-code-router")), false);
  assert.equal(await exists(join(home, "shared-appdata", "claude-code-router")), false);
  assert.doesNotMatch(await readFile(paths.projectConfig, "utf8"), /access|virtual/);
});

test("uses an existing project configuration without bootstrap discovery", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-project-existing-"));
  const paths = resolvePaths({ home, platform: "linux" });
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(paths.projectDir, { recursive: true });
  await writeFile(paths.projectConfig, JSON.stringify({
    localSecret: "existing-local",
    model: "existing-model",
    models: ["existing-model"],
    proxy: "direct",
    shimHost: "127.0.0.1",
    shimPort: 8787
  }), "utf8");

  const config = await loadOrCreateProjectConfig(paths, {
    listModels: async () => assert.fail("must not discover models"),
    secret: () => assert.fail("must not create a secret")
  });
  assert.equal(config.model, "existing-model");
  assert.equal(config.proxy, "direct");
});

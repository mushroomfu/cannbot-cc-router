import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reconcileCcrConfig } from "../src/ccr-config.js";
import { CcrV2Adapter } from "../src/ccr-v2-adapter.js";
import {
  initializeProject,
  listCannbotModels,
  loadProjectConfig,
  parseCannbotModels
} from "../src/default-service.js";
import { readJsonFile, writeJsonAtomic } from "../src/file-store.js";
import { resolvePaths } from "../src/paths.js";

test("normalizes and de-duplicates Cannbot models in reported order", () => {
  assert.deepEqual(parseCannbotModels([
    "cannbot/glm-5.2",
    "cannbot/deepseek-v4-pro",
    "cannbot/glm-5.2",
    "noise"
  ].join("\n")), ["glm-5.2", "deepseek-v4-pro"]);
});

test("rejects an empty normalized Cannbot model catalog", async () => {
  const callable = listCannbotModels as unknown as (
    runner: () => Promise<{ code: number; stdout: string; stderr: string }>
  ) => Promise<string[]>;
  await assert.rejects(callable(async () => ({
    code: 0,
    stdout: "noise only",
    stderr: ""
  })), /Unable to query Cannbot models/);
});

test("loads legacy project configuration with its selected model as the catalog", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-legacy-config-"));
  const paths = resolvePaths({ home, platform: "linux" });
  await writeJsonAtomic(paths.projectConfig, {
    model: "glm-5.2",
    shimHost: "127.0.0.1",
    shimPort: 8787,
    localSecret: "local",
    proxy: "auto"
  });

  assert.deepEqual((await loadProjectConfig(paths) as { models?: string[] }).models, ["glm-5.2"]);
});

test("initialization persists all models and manages all Cannbot routes", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-model-catalog-"));
  const paths = resolvePaths({ home, platform: "linux" });
  await writeJsonAtomic(paths.cannbotSession, { accessToken: "access-secret" });
  await writeJsonAtomic(paths.openCodeAuthCandidates[0], {
    "cannbot-vk": { key: "virtual-secret" }
  });
  await writeJsonAtomic(paths.ccrConfig, {
    Providers: [{ name: "existing", api_key: "existing", models: ["old"] }],
    Router: {
      default: "existing,old",
      think: "existing,old",
      background: "existing,old",
      longContext: "existing,old",
      webSearch: "existing,old"
    }
  });

  const config = await initializeProject({
    model: "glm-5.2",
    proxy: "auto",
    shimPort: 8787,
    setDefault: true
  }, {
    paths,
    ccr: new CcrV2Adapter(paths),
    listModels: async () => ["deepseek-v4-pro", "glm-5.2"],
    secret: () => "local-secret"
  });
  const stored = await readJsonFile<Record<string, unknown>>(paths.ccrConfig);
  const provider = (stored.Providers as Array<Record<string, unknown>>)
    .find((candidate) => candidate.name === "cannbot");

  assert.deepEqual((config as { models?: string[] }).models, ["deepseek-v4-pro", "glm-5.2"]);
  assert.deepEqual(provider?.models, ["deepseek-v4-pro", "glm-5.2"]);
  const router = stored.Router as Record<string, string>;
  for (const key of ["default", "think", "background", "longContext"]) {
    assert.equal(router[key], "cannbot,glm-5.2");
  }
  assert.equal(router.webSearch, "existing,old");
});

test("CCR reconciliation rejects a catalog missing the selected model", () => {
  assert.throws(() => reconcileCcrConfig({
    Providers: [],
    Router: {}
  }, {
    shimPort: 8787,
    localSecret: "local",
    model: "glm-5.2",
    models: ["deepseek-v4-pro"],
    setDefault: true
  } as Parameters<typeof reconcileCcrConfig>[1]), /selected model/i);
});

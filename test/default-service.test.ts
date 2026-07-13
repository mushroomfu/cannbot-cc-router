import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initializeProject, parseCannbotModels } from "../src/default-service.js";
import { CcrV2Adapter } from "../src/ccr-v2-adapter.js";
import { CcrV3Adapter } from "../src/ccr-v3-adapter.js";
import { openV3Store } from "../src/ccr-v3-store.js";
import { readJsonFile, writeJsonAtomic } from "../src/file-store.js";
import { resolvePaths } from "../src/paths.js";
import type { ProjectConfig } from "../src/types.js";

test("parses Cannbot provider-prefixed model output", () => {
  assert.deepEqual(parseCannbotModels([
    "cannbot/deepseek-v4-pro",
    "cannbot/glm-5.2",
    "noise from a plugin"
  ].join("\n")), ["deepseek-v4-pro", "glm-5.2"]);
});

test("initializes secure project and managed CCR configuration", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-default-service-"));
  const paths = resolvePaths({ home, platform: "linux" });
  await writeJsonAtomic(paths.openCodeAuthCandidates[0], {
    cannbot: { access: "access-secret" },
    "cannbot-vk": { key: "virtual-secret" }
  });
  await writeJsonAtomic(paths.ccrConfig, {
    LOG: false,
    Providers: [{ name: "existing", api_key: "existing-key", models: ["old"] }],
    Router: { default: "existing,old", think: "existing,old" }
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
    secret: () => "generated-local-secret"
  });

  assert.equal(config.model, "glm-5.2");
  assert.match(config.ccrBackup!, /config\.json\.backup-/);
  assert.equal(await readFile(config.ccrBackup!, "utf8"), [
    "{",
    '  "LOG": false,',
    '  "Providers": [',
    "    {",
    '      "name": "existing",',
    '      "api_key": "existing-key",',
    '      "models": [',
    '        "old"',
    "      ]",
    "    }",
    "  ],",
    '  "Router": {',
    '    "default": "existing,old",',
    '    "think": "existing,old"',
    "  }",
    "}",
    ""
  ].join("\n"));

  const storedProject = await readJsonFile<ProjectConfig>(paths.projectConfig);
  const storedCcr = await readJsonFile<Record<string, unknown>>(paths.ccrConfig);
  const combined = JSON.stringify({ storedProject, storedCcr });
  assert.doesNotMatch(combined, /access-secret|virtual-secret/);
  assert.match(combined, /generated-local-secret/);
  assert.deepEqual((storedCcr.Providers as Array<{ name: string }>).map((provider) => provider.name), [
    "existing", "cannbot"
  ]);
  assert.equal((storedCcr.Router as Record<string, string>).default, "cannbot,glm-5.2");
  assert.equal((storedCcr.Router as Record<string, string>).think, "cannbot,glm-5.2");
});

test("rejects an unavailable model before writing configuration", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-default-model-"));
  const paths = resolvePaths({ home, platform: "linux" });
  await writeJsonAtomic(paths.openCodeAuthCandidates[0], {
    cannbot: { access: "access" },
    "cannbot-vk": { key: "key" }
  });
  await writeJsonAtomic(paths.ccrConfig, { Providers: [], Router: {} });

  await assert.rejects(initializeProject({
    model: "missing-model",
    proxy: "auto",
    shimPort: 8787,
    setDefault: true
  }, {
    paths,
    listModels: async () => ["glm-5.2"],
    secret: () => "local"
  }), /not available/);
  await assert.rejects(readJsonFile(paths.projectConfig), { code: "ENOENT" });
});

test("initializes a managed Cannbot provider in CCR v3 SQLite", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-default-v3-"));
  const paths = resolvePaths({ home, platform: "linux" });
  await writeJsonAtomic(paths.openCodeAuthCandidates[0], {
    cannbot: { access: "access-secret" },
    "cannbot-vk": { key: "virtual-secret" }
  });
  const ccr = new CcrV3Adapter({
    paths,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    health: async () => false
  });

  await initializeProject({
    model: "glm-5.2",
    proxy: "auto",
    shimPort: 8787,
    setDefault: true
  }, {
    paths,
    ccr,
    listModels: async () => ["glm-5.2"],
    secret: () => "generated-local-secret"
  });

  const store = await openV3Store(paths);
  assert.deepEqual((await store.readConfig()).Providers.map((provider) => provider.name), ["cannbot"]);
  assert.deepEqual(await store.readApiKeys(), [{
    id: "cannbot-cc", name: "cannbot-cc", key: "generated-local-secret"
  }]);
  await store.close();
});

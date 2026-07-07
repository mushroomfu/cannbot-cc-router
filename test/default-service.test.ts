import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initializeProject, parseCannbotModels } from "../src/default-service.js";
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
  await writeJsonAtomic(paths.cannbotSession, { accessToken: "access-secret" });
  await writeJsonAtomic(paths.openCodeAuthCandidates[0], {
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
  assert.equal((storedCcr.Router as Record<string, string>).think, "existing,old");
});

test("rejects an unavailable model before writing configuration", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-default-model-"));
  const paths = resolvePaths({ home, platform: "linux" });
  await writeJsonAtomic(paths.cannbotSession, { accessToken: "access" });
  await writeJsonAtomic(paths.openCodeAuthCandidates[0], { "cannbot-vk": { key: "key" } });
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

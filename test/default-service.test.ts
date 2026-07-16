import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDefaultRouterService, parseCannbotModels } from "../src/default-service.js";
import { resolvePaths } from "../src/paths.js";

test("parses Cannbot provider-prefixed model output", () => {
  assert.deepEqual(parseCannbotModels([
    "cannbot/deepseek-v4-pro",
    "cannbot/glm-5.2",
    "noise from a plugin"
  ].join("\n")), ["deepseek-v4-pro", "glm-5.2"]);
});

test("wires code exclusively to the private session runner", async () => {
  const home = await mkdtemp(join(tmpdir(), "cannbot-private-wiring-"));
  const paths = resolvePaths({ home, platform: "linux" });
  const trace: string[] = [];
  const service = createDefaultRouterService(paths, async (args, options, dependencies) => {
    const loaded = await dependencies.loadConfig();
    trace.push(`private:${args.join("|")}:${options.contextWindow}:${loaded.model}`);
    return 8;
  }, {
    listModels: async () => ["glm-5.2"],
    secret: () => "bootstrap-seed"
  });

  assert.equal(await service.code(["-p", "hello"], { contextWindow: "1m" }), 8);
  assert.deepEqual(trace, ["private:-p|hello:1m:glm-5.2"]);
});

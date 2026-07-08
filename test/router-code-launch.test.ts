import assert from "node:assert/strict";
import test from "node:test";

import { RouterService } from "../src/router-service.js";
import type { ProjectConfig } from "../src/types.js";

const config: ProjectConfig = {
  model: "glm-5.2",
  models: ["glm-5.2"],
  shimHost: "127.0.0.1",
  shimPort: 8787,
  localSecret: "local",
  proxy: "auto"
};

test("code starts services then launches Claude directly with refreshed config", async () => {
  const trace: string[] = [];
  const service = new RouterService({
    initialize: async () => config,
    loadConfig: async () => { trace.push("load"); return config; },
    validateCredentials: async () => { trace.push("credentials"); },
    reconcile: async () => { trace.push("reconcile"); },
    ensureShim: async () => { trace.push("shim"); },
    startCcr: async () => { trace.push("ccr"); },
    stopShim: async () => true,
    stopCcr: async () => true,
    restartCcr: async () => true,
    shimStatus: async () => true,
    ccrStatus: async () => true,
    runCcrCode: async () => { trace.push("old-ccr-code"); return 9; },
    runClaudeCode: async (args: readonly string[], received: ProjectConfig) => {
      trace.push(`claude:${args.join("|")}:${received.model}`);
      return 4;
    }
  } as never);

  assert.equal(await service.code(["-p", "hello"]), 4);
  assert.deepEqual(trace, [
    "load",
    "credentials",
    "reconcile",
    "shim",
    "ccr",
    "load",
    "claude:-p|hello:glm-5.2"
  ]);
});

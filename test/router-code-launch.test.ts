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
test("code uses only the private Claude session path", async () => {
  const trace: string[] = [];
  const forbidden = async (): Promise<never> => {
    trace.push("legacy-path");
    throw new Error("legacy shared CCR path must not run");
  };
  const service = new RouterService({
    initialize: forbidden,
    loadConfig: forbidden,
    validateCredentials: forbidden,
    reconcile: forbidden,
    prepareCcrForReconcile: forbidden,
    ensureShim: forbidden,
    startCcr: forbidden,
    stopShim: forbidden,
    stopCcr: forbidden,
    restartCcr: forbidden,
    shimStatus: forbidden,
    ccrStatus: forbidden,
    runClaudeCode: forbidden,
    runPrivateClaudeCode: async (args: readonly string[], options: { contextWindow?: string }) => {
      trace.push(`private:${args.join("|")}:${options.contextWindow}`);
      return 4;
    }
  } as never);

  assert.equal(await service.code(["-p", "hello"], { contextWindow: "1m" }), 4);
  assert.deepEqual(trace, ["private:-p|hello:1m"]);
});

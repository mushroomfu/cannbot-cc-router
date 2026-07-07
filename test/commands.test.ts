import assert from "node:assert/strict";
import test from "node:test";

import { RouterService, type RouterServiceDependencies } from "../src/router-service.js";
import type { ProjectConfig } from "../src/types.js";

const config: ProjectConfig = {
  model: "glm-5.2",
  models: ["glm-5.2"],
  shimHost: "127.0.0.1",
  shimPort: 8787,
  localSecret: "local-secret",
  proxy: "auto"
};

function serviceWithTrace(): { service: RouterService; trace: string[] } {
  const trace: string[] = [];
  const dependencies: RouterServiceDependencies = {
    initialize: async () => { trace.push("initialize"); return config; },
    loadConfig: async () => { trace.push("load-config"); return config; },
    validateCredentials: async () => { trace.push("validate-credentials"); },
    reconcile: async (_config, setDefault) => { trace.push(`reconcile:${setDefault}`); },
    ensureShim: async () => { trace.push("ensure-shim"); },
    startCcr: async () => { trace.push("start-ccr"); },
    stopShim: async () => { trace.push("stop-shim"); return true; },
    stopCcr: async () => { trace.push("stop-ccr"); return true; },
    restartCcr: async () => { trace.push("restart-ccr"); return true; },
    shimStatus: async () => { trace.push("shim-status"); return true; },
    ccrStatus: async () => { trace.push("ccr-status"); return true; },
    runCcrCode: async (args) => { trace.push(`ccr-code:${args.join("|")}`); return 4; }
  };
  return { service: new RouterService(dependencies), trace };
}

test("start validates and reconciles before starting services", async () => {
  const { service, trace } = serviceWithTrace();
  await service.start({ setDefault: false });
  assert.deepEqual(trace, [
    "load-config",
    "validate-credentials",
    "reconcile:false",
    "ensure-shim",
    "start-ccr"
  ]);
});

test("code starts services and passes Claude arguments unchanged", async () => {
  const { service, trace } = serviceWithTrace();
  const code = await service.code(["-p", "hello world", "--allowedTools", "Read"]);
  assert.equal(code, 4);
  assert.deepEqual(trace, [
    "load-config",
    "validate-credentials",
    "reconcile:false",
    "ensure-shim",
    "start-ccr",
    "ccr-code:-p|hello world|--allowedTools|Read"
  ]);
});

test("restart refreshes the shim before restarting CCR", async () => {
  const { service, trace } = serviceWithTrace();
  await service.restart({ setDefault: true });
  assert.deepEqual(trace, [
    "load-config",
    "validate-credentials",
    "reconcile:true",
    "stop-shim",
    "ensure-shim",
    "restart-ccr"
  ]);
});

test("stop and status operate only on managed services", async () => {
  const { service, trace } = serviceWithTrace();
  assert.deepEqual(await service.status(), { shim: true, ccr: true });
  assert.deepEqual(await service.stop(), { shim: true, ccr: true });
  assert.deepEqual(trace, [
    "load-config", "shim-status", "ccr-status",
    "load-config", "stop-shim", "stop-ccr"
  ]);
});

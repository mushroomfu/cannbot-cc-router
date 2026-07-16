import assert from "node:assert/strict";
import test from "node:test";

import type { RunClaudeOptions } from "../src/claude-launcher.js";
import type { ShimOptions } from "../src/shim.js";
import type { ProjectConfig } from "../src/types.js";

const config: ProjectConfig = {
  localSecret: "legacy-secret",
  model: "glm-5.2",
  models: ["glm-5.2"],
  proxy: "auto",
  shimHost: "127.0.0.1",
  shimPort: 8787
};

interface FakeSession {
  gatewayApiKey: string;
  gatewayUrl: string;
  localSecret: string;
  root: string;
  start(shimPort: number): Promise<void>;
  dispose(): Promise<void>;
}

async function loadModule(): Promise<{
  runPrivateClaudeCodeSession(
    args: readonly string[],
    options: RunClaudeOptions,
    dependencies: Record<string, unknown>
  ): Promise<number>;
}> {
  const modulePath = "../src/private-code-session.js";
  return await import(modulePath) as never;
}

function dependencies(trace: string[], failClaude = false) {
  let shimOptions: ShimOptions | undefined;
  const session: FakeSession = {
    gatewayApiKey: "gateway-session-key",
    gatewayUrl: "http://127.0.0.1:44001",
    localSecret: "shim-session-key",
    root: "C:\\private-session",
    start: async (port) => { trace.push(`ccr-start:${port}`); },
    dispose: async () => { trace.push("ccr-dispose"); }
  };
  return {
    capturedShim: () => shimOptions,
    dependencies: {
      createShim: (options: ShimOptions) => {
        shimOptions = options;
        trace.push("shim-create");
        return {
          address: () => ({ host: "127.0.0.1", port: 44002 }),
          close: async () => { trace.push("shim-close"); },
          instanceId: "shim-instance",
          listen: async () => { trace.push("shim-listen"); return { host: "127.0.0.1", port: 44002 }; }
        };
      },
      loadConfig: async () => { trace.push("config"); return config; },
      prepareSession: async (options: { models: readonly string[] }) => {
        trace.push(`session:${options.models.join(",")}`);
        return session;
      },
      readCredentials: async () => ({ accessToken: "access", virtualKey: "virtual" }),
      refreshCredentials: async () => { trace.push("refresh"); },
      runClaudeCode: async (args: readonly string[], received: ProjectConfig, options: RunClaudeOptions) => {
        trace.push(`claude:${args.join("|")}:${received.shimPort}:${received.localSecret}:${options.contextWindow}`);
        if (failClaude) throw new Error("Claude failed");
        return 7;
      },
      validateCredentials: async () => { trace.push("credentials"); }
    },
    session
  };
}

test("runs Claude through one matching private shim and CCR session", async () => {
  const { runPrivateClaudeCodeSession } = await loadModule();
  const trace: string[] = [];
  const fixture = dependencies(trace);
  const code = await runPrivateClaudeCodeSession(
    ["-p", "hello"],
    { contextWindow: "1m" },
    fixture.dependencies
  );
  assert.equal(code, 7);
  assert.equal(fixture.capturedShim()?.ccrApiKey, fixture.session.gatewayApiKey);
  assert.equal(fixture.capturedShim()?.ccrUrl, fixture.session.gatewayUrl);
  assert.equal(fixture.capturedShim()?.localSecret, fixture.session.localSecret);
  assert.deepEqual(trace, [
    "config",
    "credentials",
    "session:glm-5.2",
    "shim-create",
    "shim-listen",
    "ccr-start:44002",
    "claude:-p|hello:44002:shim-session-key:1m",
    "ccr-dispose",
    "shim-close"
  ]);
});

test("disposes private CCR before shim when Claude fails", async () => {
  const { runPrivateClaudeCodeSession } = await loadModule();
  const trace: string[] = [];
  const fixture = dependencies(trace, true);
  await assert.rejects(
    () => runPrivateClaudeCodeSession([], {}, fixture.dependencies),
    /Claude failed/
  );
  assert.deepEqual(trace.slice(-2), ["ccr-dispose", "shim-close"]);
});

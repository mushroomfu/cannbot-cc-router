import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import test from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import type { DetectedCcrVersion } from "../src/ccr-version.js";
import type { SeedPrivateCcrStoreOptions } from "../src/private-ccr-store.js";

interface PrivateCcrSession {
  readonly gatewayApiKey: string;
  readonly gatewayUrl: string;
  readonly localSecret: string;
  readonly root: string;
  start(shimPort: number): Promise<void>;
  dispose(): Promise<void>;
}

interface SessionDependencies {
  allocatePort(): Promise<number>;
  resolveCcrArtifact(): Promise<{ entry: string; version: DetectedCcrVersion }>;
  secret(): string;
  seedStore(options: SeedPrivateCcrStoreOptions): Promise<unknown>;
  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  waitForGateway(port: number): Promise<void>;
}

async function loadSessionModule(): Promise<{
  preparePrivateCcrSession(options: {
    dependencies: SessionDependencies;
    models: readonly string[];
    parentEnv?: NodeJS.ProcessEnv;
  }): Promise<PrivateCcrSession>;
}> {
  const modulePath = "../src/private-ccr-session.js";
  return await import(modulePath) as never;
}

function fakeChild(trace: string[]): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    killed: false,
    kill: (signal: NodeJS.Signals) => {
      trace.push(`kill:${signal}`);
      queueMicrotask(() => child.emit("exit", 0, signal));
      return true;
    },
    pid: 43210,
    stderr: null,
    stdin: null,
    stdout: null
  });
  return child;
}

test("owns a foreground CCR 3.0.6 child and disposes only its private root", async () => {
  const { preparePrivateCcrSession } = await loadSessionModule();
  const trace: string[] = [];
  const ports = [43111, 43112, 43113];
  const secrets = ["shim-session-key", "gateway-session-key"];
  let spawnRecord: { command: string; args: readonly string[]; options: SpawnOptions } | undefined;
  let seed: SeedPrivateCcrStoreOptions | undefined;
  const child = fakeChild(trace);
  const session = await preparePrivateCcrSession({
    models: ["glm-5.2"],
    parentEnv: { CODEX_HOME: "must-not-leak", PATH: "private-path" },
    dependencies: {
      allocatePort: async () => ports.shift()!,
      resolveCcrArtifact: async () => ({
        entry: "C:\\private-package\\dist\\main\\cli.js",
        version: { major: 3, version: "3.0.6" }
      }),
      secret: () => secrets.shift()!,
      seedStore: async (options) => { seed = options; return {}; },
      spawn: (command, args, options) => {
        spawnRecord = { command, args, options };
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
      waitForGateway: async (port) => { trace.push(`ready:${port}`); }
    }
  });

  try {
    assert.equal(session.gatewayUrl, "http://127.0.0.1:43112");
    assert.equal(session.localSecret, "shim-session-key");
    assert.equal(session.gatewayApiKey, "gateway-session-key");
    assert.equal(existsSync(session.root), true);
    await session.start(43114);
    assert.equal(seed?.gatewayPort, 43112);
    assert.equal(seed?.corePort, 43113);
    assert.equal(seed?.shimPort, 43114);
    assert.equal(seed?.gatewayApiKey, session.gatewayApiKey);
    assert.equal(seed?.localSecret, session.localSecret);
    assert.equal(spawnRecord?.command, process.execPath);
    assert.deepEqual(spawnRecord?.args, [
      "C:\\private-package\\dist\\main\\cli.js",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "43111",
      "--gateway",
      "--no-open"
    ]);
    assert.equal(spawnRecord?.options.detached, false);
    assert.equal(spawnRecord?.options.stdio, "ignore");
    assert.equal(spawnRecord?.options.env?.CODEX_HOME, undefined);
    assert.equal(spawnRecord?.options.env?.CCR_INTERNAL_HOME_DIR?.startsWith(session.root), true);
    assert.deepEqual(trace, ["ready:43112", "ready:43113"]);
  } finally {
    await session.dispose();
  }
  assert.deepEqual(trace, ["ready:43112", "ready:43113", "kill:SIGTERM"]);
  assert.equal(existsSync(session.root), false);
  await session.dispose();
  assert.deepEqual(trace, ["ready:43112", "ready:43113", "kill:SIGTERM"]);
});

test("rejects a non-latest CCR artifact before creating a private root", async () => {
  const { preparePrivateCcrSession } = await loadSessionModule();
  for (const version of ["3.0.3", "3.0.5", "3.0.14"]) {
    await assert.rejects(() => preparePrivateCcrSession({
      models: ["glm-5.2"],
      dependencies: {
        allocatePort: async () => assert.fail("must not allocate ports"),
        resolveCcrArtifact: async () => ({
          entry: "C:\\private-package\\dist\\main\\cli.js",
          version: { major: 3, version }
        }),
        secret: () => assert.fail("must not create secrets"),
        seedStore: async () => assert.fail("must not seed"),
        spawn: () => assert.fail("must not spawn"),
        waitForGateway: async () => assert.fail("must not probe")
      }
    }), /requires the npm latest CCR CLI 3\.0\.6/i);
  }
});

test("terminates the owned foreground child when gateway readiness fails", async () => {
  const { preparePrivateCcrSession } = await loadSessionModule();
  const trace: string[] = [];
  const ports = [43211, 43212, 43213];
  const secrets = ["shim-key", "gateway-key"];
  const child = fakeChild(trace);
  const session = await preparePrivateCcrSession({
    models: ["glm-5.2"],
    dependencies: {
      allocatePort: async () => ports.shift()!,
      resolveCcrArtifact: async () => ({ entry: "C:\\private\\cli.js", version: { major: 3, version: "3.0.6" } }),
      secret: () => secrets.shift()!,
      seedStore: async () => ({}),
      spawn: () => { queueMicrotask(() => child.emit("spawn")); return child; },
      waitForGateway: async () => { throw new Error("gateway timeout"); }
    }
  });
  await assert.rejects(() => session.start(43214), /gateway timeout/);
  assert.deepEqual(trace, ["kill:SIGTERM"]);
  await session.dispose();
  assert.equal(existsSync(session.root), false);
  assert.deepEqual(trace, ["kill:SIGTERM"]);
});

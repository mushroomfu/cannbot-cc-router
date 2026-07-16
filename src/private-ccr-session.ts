import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { parseSupportedCcrVersion, type DetectedCcrVersion } from "./ccr-version.js";
import {
  createPrivateCcrEnvironment,
  type PrivateCcrEnvironment
} from "./private-ccr-environment.js";
import {
  seedPrivateCcrStore,
  type PrivateCcrStoreLayout,
  type SeedPrivateCcrStoreOptions
} from "./private-ccr-store.js";

const PRIVATE_CCR_VERSION = "3.0.6";
const LOOPBACK = "127.0.0.1";

type SpawnPrivateCcr = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface ResolvedPrivateCcrArtifact {
  readonly entry: string;
  readonly version: DetectedCcrVersion;
}

export interface PrivateCcrSessionDependencies {
  allocatePort?: () => Promise<number>;
  createEnvironment?: typeof createPrivateCcrEnvironment;
  resolveCcrArtifact?: () => Promise<ResolvedPrivateCcrArtifact>;
  secret?: () => string;
  seedStore?: (options: SeedPrivateCcrStoreOptions) => Promise<PrivateCcrStoreLayout | unknown>;
  spawn?: SpawnPrivateCcr;
  waitForGateway?: (port: number) => Promise<void>;
}

export interface PreparePrivateCcrSessionOptions {
  readonly dependencies?: PrivateCcrSessionDependencies;
  readonly models: readonly string[];
  readonly parentEnv?: NodeJS.ProcessEnv;
}

export interface PrivateCcrSession {
  readonly gatewayApiKey: string;
  readonly gatewayUrl: string;
  readonly localSecret: string;
  readonly root: string;
  dispose(): Promise<void>;
  start(shimPort: number): Promise<void>;
}

export function resolveBundledCcrArtifact(): Promise<ResolvedPrivateCcrArtifact> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@musistudio/claude-code-router");
  const metadataPath = join(dirname(dirname(dirname(entry))), "package.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { version?: unknown };
  if (typeof metadata.version !== "string") {
    throw new Error("Bundled CCR package version is missing");
  }
  return Promise.resolve({ entry, version: parseSupportedCcrVersion(metadata.version) });
}

function defaultAllocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a private loopback port"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function probeGateway(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: LOOPBACK, port });
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("error", reject);
  });
}

async function defaultWaitForGateway(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await probeGateway(port);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Private CCR gateway startup timed out");
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => { child.off("error", onError); resolve(); };
    const onError = (error: Error): void => { child.off("spawn", onSpawn); reject(error); };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

function withTimeout(operation: Promise<void>, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Owned CCR child did not exit")), milliseconds);
    operation.then(
      () => { clearTimeout(timer); resolve(); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

async function allocateDistinctPorts(allocate: () => Promise<number>): Promise<[number, number, number]> {
  const ports: number[] = [];
  while (ports.length < 3) {
    const port = await allocate();
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("Private CCR port allocator returned an invalid port");
    }
    if (!ports.includes(port)) ports.push(port);
  }
  return ports as [number, number, number];
}

export async function preparePrivateCcrSession(
  options: PreparePrivateCcrSessionOptions
): Promise<PrivateCcrSession> {
  const dependencies = options.dependencies ?? {};
  const artifact = await (dependencies.resolveCcrArtifact ?? resolveBundledCcrArtifact)();
  if (artifact.version.major !== 3 || artifact.version.version !== PRIVATE_CCR_VERSION) {
    throw new Error(`Private lifecycle requires the npm latest CCR CLI ${PRIVATE_CCR_VERSION}`);
  }

  const environment = await (dependencies.createEnvironment ?? createPrivateCcrEnvironment)({
    parentEnv: options.parentEnv
  });
  let child: ChildProcess | undefined;
  let childExit: Promise<void> | undefined;
  let disposed = false;
  let started = false;
  try {
    const [webPort, gatewayPort, corePort] = await allocateDistinctPorts(
      dependencies.allocatePort ?? defaultAllocatePort
    );
    const secret = dependencies.secret ?? (() => randomBytes(32).toString("base64url"));
    const localSecret = secret();
    const gatewayApiKey = secret();
    if (!localSecret || !gatewayApiKey || localSecret === gatewayApiKey) {
      throw new Error("Private CCR session secrets must be non-empty and distinct");
    }
    const seedStore = dependencies.seedStore ?? seedPrivateCcrStore;
    const spawn = dependencies.spawn ?? ((command, args, spawnOptions) =>
      nodeSpawn(command, [...args], spawnOptions));
    const waitForGateway = dependencies.waitForGateway ?? defaultWaitForGateway;

    const stopChild = async (): Promise<void> => {
      const owned = child;
      const exited = childExit;
      child = undefined;
      childExit = undefined;
      if (!owned || !exited) return;
      if (owned.exitCode !== null && owned.exitCode !== undefined) return;
      if (owned.signalCode !== null && owned.signalCode !== undefined) return;
      if (!owned.kill("SIGTERM")) return;
      await withTimeout(exited, 10_000);
    };

    return {
      gatewayApiKey,
      gatewayUrl: `http://${LOOPBACK}:${gatewayPort}`,
      localSecret,
      root: environment.paths.root,
      async start(shimPort: number): Promise<void> {
        if (disposed) throw new Error("Private CCR session is disposed");
        if (started) throw new Error("Private CCR session is already started");
        if ([webPort, gatewayPort, corePort].includes(shimPort)) {
          throw new Error("Private CCR Web, gateway, core, and shim ports must be distinct");
        }
        await seedStore({
          corePort,
          gatewayApiKey,
          gatewayPort,
          localSecret,
          models: options.models,
          paths: environment.paths,
          shimPort,
          version: artifact.version
        });
        const owned = spawn(process.execPath, [
          artifact.entry,
          "serve",
          "--host",
          LOOPBACK,
          "--port",
          String(webPort),
          "--gateway",
          "--no-open"
        ], {
          detached: false,
          env: environment.env,
          shell: false,
          stdio: "ignore",
          windowsHide: true
        });
        await waitForSpawn(owned);
        child = owned;
        childExit = waitForExit(owned);
        try {
          await waitForGateway(gatewayPort);
          await waitForGateway(corePort);
          started = true;
        } catch (error) {
          await stopChild().catch(() => undefined);
          throw error;
        }
      },
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        try {
          await stopChild();
        } finally {
          await environment.dispose();
        }
      }
    };
  } catch (error) {
    await environment.dispose().catch(() => undefined);
    throw error;
  }
}

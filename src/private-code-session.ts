import { runClaudeCode, type RunClaudeOptions } from "./claude-launcher.js";
import {
  preparePrivateCcrSession,
  type PreparePrivateCcrSessionOptions,
  type PrivateCcrSession
} from "./private-ccr-session.js";
import { createShim, type Shim, type ShimOptions } from "./shim.js";
import type { CannbotCredentials, ProjectConfig } from "./types.js";

const CANNBOT_UPSTREAM =
  "https://cannbot.hicann.cn/gateway/compatible-mode/v1/chat/completions";

export interface PrivateCodeSessionDependencies {
  createShim?: (options: ShimOptions) => Shim;
  loadConfig(): Promise<ProjectConfig>;
  prepareSession?: (options: PreparePrivateCcrSessionOptions) => Promise<PrivateCcrSession>;
  readCredentials(): Promise<CannbotCredentials>;
  refreshCredentials(): Promise<void>;
  runClaudeCode?: typeof runClaudeCode;
  validateCredentials(): Promise<void>;
}

export async function runPrivateClaudeCodeSession(
  args: readonly string[],
  options: RunClaudeOptions,
  dependencies: PrivateCodeSessionDependencies
): Promise<number> {
  const config = await dependencies.loadConfig();
  await dependencies.validateCredentials();
  const session = await (dependencies.prepareSession ?? preparePrivateCcrSession)({
    models: config.models
  });
  let shim: Shim | undefined;
  try {
    shim = (dependencies.createShim ?? createShim)({
      ccrApiKey: session.gatewayApiKey,
      ccrUrl: session.gatewayUrl,
      host: "127.0.0.1",
      localSecret: session.localSecret,
      models: config.models,
      port: 0,
      proxyMode: config.proxy,
      readCredentials: dependencies.readCredentials,
      refreshCredentials: dependencies.refreshCredentials,
      upstreamUrl: CANNBOT_UPSTREAM
    });
    const address = await shim.listen();
    await session.start(address.port);
    return await (dependencies.runClaudeCode ?? runClaudeCode)(args, {
      ...config,
      localSecret: session.localSecret,
      shimHost: "127.0.0.1",
      shimPort: address.port
    }, options);
  } finally {
    try {
      await session.dispose();
    } finally {
      await shim?.close();
    }
  }
}

import type { ContextWindow } from "./claude-launcher.js";

export interface ClaudeCodeOptions {
  contextWindow?: ContextWindow;
}

export interface RouterServiceDependencies {
  runPrivateClaudeCode(
    args: readonly string[],
    options?: ClaudeCodeOptions
  ): Promise<number>;
}

export class RouterService {
  constructor(private readonly dependencies: RouterServiceDependencies) {}

  code(
    args: readonly string[],
    options: ClaudeCodeOptions = {}
  ): Promise<number> {
    return this.dependencies.runPrivateClaudeCode(args, options);
  }
}

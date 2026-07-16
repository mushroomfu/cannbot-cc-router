#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Command } from "commander";

import { createDefaultRouterService, runDefaultDoctor } from "./default-service.js";
import { redact } from "./redact.js";

export interface CommandHandlers {
  code(args: string[], options: unknown): Promise<number>;
  doctor(options: unknown): Promise<number>;
}

interface OutputCliOptions {
  json?: boolean;
}

interface CodeCliOptions {
  context: "200k" | "1m";
}

function contextWindowOption(value: string): "200k" | "1m" {
  if (value === "200k" || value === "1m") return value;
  throw new Error("Context window must be 200k or 1m");
}

async function safely(operation: () => Promise<number>): Promise<number> {
  try {
    return await operation();
  } catch (error) {
    console.error(redact(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

export function createDefaultHandlers(): CommandHandlers {
  const service = createDefaultRouterService();
  return {
    code: (args, raw) => safely(() => {
      const options = raw as CodeCliOptions;
      return service.code(args, { contextWindow: options.context });
    }),
    doctor: (raw) => safely(async () => {
      const options = raw as OutputCliOptions;
      const report = await runDefaultDoctor();
      if (options.json) {
        console.log(JSON.stringify(report));
      } else {
        for (const check of report.checks) {
          const mark = check.status === "pass" ? "PASS" : "FAIL";
          console.log(`[${mark}] ${check.name}: ${check.detail}`);
          if (check.action && check.status !== "pass") console.log(`       ${check.action}`);
        }
      }
      return report.ok ? 0 : 1;
    })
  };
}

export function buildProgram(
  handlers: CommandHandlers = createDefaultHandlers()
): Command {
  const program = new Command()
    .name("cannbot-cc")
    .description("Launch an isolated Cannbot session in Claude Code")
    .version("0.1.0");

  program
    .command("code [args...]")
    .option("--context <window>", "Claude context window: 200k or 1m", contextWindowOption, "200k")
    .allowUnknownOption(true)
    .action(async (args: string[] = [], options) => {
      process.exitCode = await handlers.code(args, options);
    });
  program.command("doctor").option("--json", "emit JSON").action(async (options) => {
    process.exitCode = await handlers.doctor(options);
  });

  return program;
}

const invokedPath = process.argv[1];
function isMainEntry(invoked: string | undefined): boolean {
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(invoked).href;
  }
}
if (isMainEntry(invokedPath)) {
  await buildProgram().parseAsync(process.argv);
}

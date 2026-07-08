#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Command, Option } from "commander";

import { createDefaultRouterService, runDefaultDoctor } from "./default-service.js";
import { redact } from "./redact.js";

export interface CommandHandlers {
  init(options: unknown): Promise<number>;
  sync(options: unknown): Promise<number>;
  start(options: unknown): Promise<number>;
  restart(options: unknown): Promise<number>;
  stop(options: unknown): Promise<number>;
  status(options: unknown): Promise<number>;
  code(args: string[], options: unknown): Promise<number>;
  doctor(options: unknown): Promise<number>;
}

interface InitCliOptions {
  model: string;
  proxy: string;
  shimPort: number;
  setDefault?: boolean;
}

interface SyncCliOptions {
  setDefault?: boolean;
}

interface OutputCliOptions {
  json?: boolean;
}

function numberOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid integer: ${value}`);
  return parsed;
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
    init: (raw) => safely(async () => {
      const options = raw as InitCliOptions;
      const config = await service.init({
        model: options.model,
        proxy: options.proxy,
        shimPort: options.shimPort,
        setDefault: Boolean(options.setDefault)
      });
      console.log(`Initialized Cannbot model ${config.model} on 127.0.0.1:${config.shimPort}`);
      if (config.ccrBackup) console.log(`CCR backup: ${config.ccrBackup}`);
      return 0;
    }),
    sync: (raw) => safely(async () => {
      const options = raw as SyncCliOptions;
      await service.sync({ setDefault: Boolean(options.setDefault) });
      console.log("Cannbot and CCR configuration synchronized");
      return 0;
    }),
    start: (raw) => safely(async () => {
      const options = raw as SyncCliOptions;
      await service.start({ setDefault: Boolean(options.setDefault) });
      console.log("Cannbot shim and CCR are running");
      return 0;
    }),
    restart: (raw) => safely(async () => {
      const options = raw as SyncCliOptions;
      await service.restart({ setDefault: Boolean(options.setDefault) });
      console.log("Cannbot shim and CCR restarted");
      return 0;
    }),
    stop: () => safely(async () => {
      const status = await service.stop();
      console.log(`Stopped shim=${status.shim} ccr=${status.ccr}`);
      return 0;
    }),
    status: (raw) => safely(async () => {
      const options = raw as OutputCliOptions;
      const status = await service.status();
      if (options.json) console.log(JSON.stringify(status));
      else console.log(`Shim: ${status.shim ? "running" : "stopped"}; CCR: ${status.ccr ? "running" : "stopped"}`);
      return status.shim && status.ccr ? 0 : 1;
    }),
    code: (args) => safely(() => service.code(args)),
    doctor: (raw) => safely(async () => {
      const options = raw as OutputCliOptions;
      const report = await runDefaultDoctor();
      if (options.json) {
        console.log(JSON.stringify(report));
      } else {
        for (const check of report.checks) {
          const mark = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
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
    .description("Use Cannbot models from Claude Code through CCR")
    .version("0.1.0");

  program
    .command("init")
    .option("--model <id>", "Cannbot model ID", "glm-5.2")
    .addOption(new Option("--proxy <mode>", "auto, direct, or proxy URL").default("auto"))
    .option("--shim-port <port>", "loopback credential shim port", numberOption, 8787)
    .option("--set-default", "set CCR Router.default to the Cannbot model")
    .action(async (options) => { process.exitCode = await handlers.init(options); });
  program
    .command("sync")
    .option("--set-default", "set CCR Router.default to the Cannbot model")
    .action(async (options) => { process.exitCode = await handlers.sync(options); });
  program
    .command("start")
    .option("--set-default", "set CCR Router.default to the Cannbot model")
    .action(async (options) => { process.exitCode = await handlers.start(options); });
  program
    .command("restart")
    .option("--set-default", "set CCR Router.default to the Cannbot model")
    .action(async (options) => { process.exitCode = await handlers.restart(options); });
  program.command("stop").action(async (options) => {
    process.exitCode = await handlers.stop(options);
  });
  program.command("status").option("--json", "emit JSON").action(async (options) => {
    process.exitCode = await handlers.status(options);
  });
  program
    .command("code [args...]")
    .allowUnknownOption(true)
    .action(async (args: string[] = [], options) => {
      process.exitCode = await handlers.code(args, options);
    });
  program.command("doctor").option("--json", "emit JSON").action(async (options) => {
    process.exitCode = await handlers.doctor(options);
  });

  return program;
}

// Run only when invoked directly as the entry point, not when imported by tests.
// Compare real paths so the check still holds when this module is reached through
// a symlink (e.g. `npm install -g .` links node_modules/cannbot-cc-router to the
// source tree, and Node resolves import.meta.url to the real path while
// process.argv[1] stays as the symlink path).
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

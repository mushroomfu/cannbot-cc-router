#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { Command } from "commander";

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

const unavailable = async (): Promise<number> => {
  throw new Error("Command handlers are not configured");
};

const unavailableHandlers: CommandHandlers = {
  init: unavailable,
  sync: unavailable,
  start: unavailable,
  restart: unavailable,
  stop: unavailable,
  status: unavailable,
  code: async () => unavailable(),
  doctor: unavailable
};

export function buildProgram(
  handlers: CommandHandlers = unavailableHandlers
): Command {
  const program = new Command()
    .name("cannbot-cc")
    .description("Use Cannbot models from Claude Code through CCR");

  program.command("init").action(async (options) => {
    process.exitCode = await handlers.init(options);
  });
  program.command("sync").action(async (options) => {
    process.exitCode = await handlers.sync(options);
  });
  program.command("start").action(async (options) => {
    process.exitCode = await handlers.start(options);
  });
  program.command("restart").action(async (options) => {
    process.exitCode = await handlers.restart(options);
  });
  program.command("stop").action(async (options) => {
    process.exitCode = await handlers.stop(options);
  });
  program.command("status").action(async (options) => {
    process.exitCode = await handlers.status(options);
  });
  program
    .command("code [args...]")
    .allowUnknownOption(true)
    .action(async (args: string[] = [], options) => {
      process.exitCode = await handlers.code(args, options);
    });
  program.command("doctor").action(async (options) => {
    process.exitCode = await handlers.doctor(options);
  });

  return program;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await buildProgram().parseAsync(process.argv);
}

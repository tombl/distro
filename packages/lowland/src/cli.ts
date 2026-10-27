#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { build, buildUsage } from "./build.ts";
import { run, runUsage } from "./run.ts";
import { EXIT_FAILURE, UsageError } from "./usage.ts";

const usage = `Usage: lowland <command> [options]

Commands:
  run    Run a command in a fresh Linux machine
  build  Build a system image from apk packages and host files

Options:
  -h, --help     Show help
  -v, --version  Show the version

Run lowland <command> --help for the options of a command.

lowland exits 125 when it fails, such as for an argument error. lowland run
otherwise exits with the command's status.
`;

const commands: Record<string, { usage: string; run: (args: string[]) => Promise<number | void> }> =
  {
    run: { usage: runUsage, run },
    build: { usage: buildUsage, run: build },
  };

const [name, ...args] = process.argv.slice(2);

if (name === undefined) {
  process.stderr.write(usage);
  process.exit(EXIT_FAILURE);
}
if (name === "-h" || name === "--help" || name === "help") {
  process.stdout.write(usage);
  process.exit(0);
}
if (name === "-v" || name === "--version") {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  process.stdout.write(`${manifest.version}\n`);
  process.exit(0);
}

const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
if (!command) {
  process.stderr.write(`lowland: unknown command ${name}\n\n${usage}`);
  process.exit(EXIT_FAILURE);
}

let code;
try {
  code = (await command.run(args)) ?? 0;
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`lowland ${name}: ${error.message}\n\n${command.usage}`);
    process.exit(EXIT_FAILURE);
  }
  process.stderr.write(`lowland ${name}: ${error instanceof Error ? error.message : error}\n`);
  process.exit(EXIT_FAILURE);
}

// A guest's stdin may keep the event loop alive, so exit explicitly once
// output has been written.
await new Promise((resolve) => process.stdout.write("", () => resolve(undefined)));
process.exit(code);

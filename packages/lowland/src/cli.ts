#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { build, buildUsage } from "./build.ts";
import { UsageError } from "./usage.ts";

const usage = `Usage: lowland <command> [options]

Commands:
  build  Build a system image from apk packages and host files

Options:
  -h, --help     Show help
  -v, --version  Show the version

Run lowland <command> --help for the options of a command.
`;

const commands: Record<string, { usage: string; run: (args: string[]) => Promise<void> }> = {
  build: { usage: buildUsage, run: build },
};

const [name, ...args] = process.argv.slice(2);

if (name === undefined) {
  process.stderr.write(usage);
  process.exit(2);
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
  process.exit(2);
}

try {
  await command.run(args);
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`lowland ${name}: ${error.message}\n\n${command.usage}`);
    process.exit(2);
  }
  process.stderr.write(`lowland ${name}: ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
}

#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildImage, type ImageFile, type ImageFormat } from "./build.ts";

const usage = `Usage: lowland-image build [options] -o <file>

Build a Lowland system image from apk packages and host files.

Options:
  -p, --package <name|path>       Install a package by name or from a local .apk (repeatable)
  -f, --file <host:guest[:mode]>  Copy a host file or directory into the image (repeatable)
  -l, --link <guest=target>       Create a symbolic link in the image (repeatable)
      --format <format>           Set the format, erofs or ext4 (default: erofs)
      --label <label>             Set the filesystem label (default: LOWLAND_ROOT)
      --size <size>               Set the image size, such as 64M (default: 256M)
  -o, --output <file>             Write the image to this path
  -h, --help                      Show help
  -v, --version                   Show the version
`;

function fail(message: string): never {
  process.stderr.write(`lowland-image: ${message}\n\n${usage}`);
  process.exit(2);
}

function parse_file(value: string): [string, ImageFile] {
  const parts = value.split(":");
  const mode = parts.length >= 3 && /^0?[0-7]{3,4}$/.test(parts.at(-1)!) ? parts.pop() : undefined;
  const guest = parts.pop();
  const source = parts.join(":");
  if (!source || !guest) fail(`--file expects host:guest[:mode], got ${value}`);
  return [guest, mode ? { source, mode } : source];
}

function parse_link(value: string): [string, string] {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    fail(`--link expects guest=target, got ${value}`);
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      package: { type: "string", short: "p", multiple: true, default: [] },
      file: { type: "string", short: "f", multiple: true, default: [] },
      link: { type: "string", short: "l", multiple: true, default: [] },
      format: { type: "string" },
      label: { type: "string" },
      size: { type: "string" },
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
} catch (error) {
  fail((error as Error).message);
}
const { values, positionals } = parsed;

if (values.help) {
  process.stdout.write(usage);
  process.exit(0);
}
if (values.version) {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  process.stdout.write(`${manifest.version}\n`);
  process.exit(0);
}
if (positionals.length !== 1 || positionals[0] !== "build") fail("expected the build command");
if (!values.output) fail("missing --output");

try {
  await buildImage({
    packages: values.package,
    files: Object.fromEntries(values.file.map(parse_file)),
    links: Object.fromEntries(values.link.map(parse_link)),
    format: values.format as ImageFormat | undefined,
    label: values.label,
    size: values.size,
    output: values.output,
  });
} catch (error) {
  process.stderr.write(`lowland-image: ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
}

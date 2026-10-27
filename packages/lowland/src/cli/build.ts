// SPDX-License-Identifier: MIT

import {
  buildImage,
  type BuildImageOptions,
  type ImageCompression,
  type ImageFile,
  type ImageFormat,
} from "@lowland/image/build";
import { parseArgs } from "node:util";
import { UsageError } from "./usage.ts";

export const buildUsage = `Usage: lowland build [options] -o <file>

Build a Lowland system image from apk packages and host files.

Options:
  -p, --package <name|path>       Install a package by name or from a local .apk (repeatable)
  -f, --file <host:guest[:mode]>  Copy a host file or directory into the image (repeatable)
  -l, --link <guest=target>       Create a symbolic link in the image (repeatable)
      --format <format>           Set the format, erofs or ext4 (default: erofs)
      --compression <compression> Compress EROFS data with deflate, lzma, or none (default: deflate)
      --label <label>             Set the filesystem label (default: none)
      --size <size>               Set the image size, such as 64M (default: 256M)
  -o, --output <file>             Write the image to this path
  -h, --help                      Show help
`;

function parse_file(value: string): [string, ImageFile] {
  const parts = value.split(":");
  const mode = parts.length >= 3 && /^0?[0-7]{3,4}$/.test(parts.at(-1)!) ? parts.pop() : undefined;
  const guest = parts.pop();
  const source = parts.join(":");
  if (!source || !guest) throw new UsageError(`--file expects host:guest[:mode], got ${value}`);
  return [guest, mode ? { source, mode } : source];
}

function parse_link(value: string): [string, string] {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new UsageError(`--link expects guest=target, got ${value}`);
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}

/** Parses `lowland build` arguments into `buildImage()` options, or `undefined` for `--help`. */
export function parseBuildArgs(args: readonly string[]): BuildImageOptions | undefined {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        package: { type: "string", short: "p", multiple: true, default: [] },
        file: { type: "string", short: "f", multiple: true, default: [] },
        link: { type: "string", short: "l", multiple: true, default: [] },
        format: { type: "string" },
        compression: { type: "string" },
        label: { type: "string" },
        size: { type: "string" },
        output: { type: "string", short: "o" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values } = parsed;
  if (values.help) return undefined;
  if (!values.output) throw new UsageError("missing --output");
  return {
    packages: values.package,
    files: Object.fromEntries(values.file.map(parse_file)),
    links: Object.fromEntries(values.link.map(parse_link)),
    format: values.format as ImageFormat | undefined,
    compression: values.compression as ImageCompression | undefined,
    label: values.label,
    size: values.size,
    output: values.output,
  };
}

/** Runs `lowland build`. */
export async function build(args: string[]): Promise<void> {
  const options = parseBuildArgs(args);
  if (!options) {
    process.stdout.write(buildUsage);
    return;
  }
  await buildImage(options);
}

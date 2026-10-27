// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseBuildArgs } from "../src/build.ts";
import { UsageError } from "../src/usage.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function lowland(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

describe("lowland", () => {
  it("prints usage with --help", () => {
    const result = lowland("--help");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Usage: lowland <command>/);
    assert.match(result.stdout, /^ {2}build /m);
  });

  it("prints the version", () => {
    const result = lowland("--version");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${version}\n`);
  });

  it("fails without a command", () => {
    const result = lowland();
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^Usage: lowland <command>/);
  });

  it("rejects unknown commands", () => {
    const result = lowland("image");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^lowland: unknown command image\n/);
  });

  it("does not treat prototype keys as commands", () => {
    assert.equal(lowland("constructor").status, 2);
  });
});

describe("lowland build", () => {
  it("prints usage with --help", () => {
    const result = lowland("build", "--help");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Usage: lowland build/);
  });

  it("reports argument errors with its usage", () => {
    const result = lowland("build", "-p", "busybox");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^lowland build: missing --output\n\nUsage: lowland build/);
  });

  it("reports build errors without usage", () => {
    const result = lowland("build", "-p", "busybox", "--format", "xfs", "-o", "out.img");
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      'lowland build: unsupported image format "xfs", expected one of: erofs, ext4\n',
    );
  });

  it("maps flags to buildImage() options", () => {
    assert.deepEqual(
      parseBuildArgs([
        "-p",
        "busybox",
        "--package",
        "./jq.apk",
        "-f",
        "./app:/usr/bin/app:0755",
        "--file",
        "C:/motd:/etc/motd",
        "-l",
        "/usr/bin/hi=/usr/bin/app",
        "--format",
        "ext4",
        "--compression",
        "none",
        "--label",
        "DATA",
        "--size",
        "64M",
        "-o",
        "app.ext4",
      ]),
      {
        packages: ["busybox", "./jq.apk"],
        files: {
          "/usr/bin/app": { source: "./app", mode: "0755" },
          "/etc/motd": "C:/motd",
        },
        links: { "/usr/bin/hi": "/usr/bin/app" },
        format: "ext4",
        compression: "none",
        label: "DATA",
        size: "64M",
        output: "app.ext4",
      },
    );
  });

  it("returns undefined for --help", () => {
    assert.equal(parseBuildArgs(["--help"]), undefined);
  });

  for (const [args, message] of [
    [["-f", "./app", "-o", "x"], /^--file expects host:guest\[:mode\], got \.\/app$/],
    [["-l", "/a", "-o", "x"], /^--link expects guest=target, got \/a$/],
    [["-l", "=b", "-o", "x"], /^--link expects guest=target/],
    [["extra", "-o", "x"], /Unexpected argument 'extra'/],
    [["--bogus", "-o", "x"], /Unknown option '--bogus'/],
  ] as const) {
    it(`rejects ${args.join(" ")}`, () => {
      assert.throws(
        () => parseBuildArgs(args),
        (error) => error instanceof UsageError && message.test(error.message),
      );
    });
  }
});

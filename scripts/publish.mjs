#!/usr/bin/env node

// Validates a release and publishes its archives, as the release job does:
//
//   node scripts/publish.mjs VERSION ARCHIVES [--dry-run]
//
// ARCHIVES is a copy of .#npm-packages. Every versioned manifest must be at
// VERSION, ARCHIVES must hold exactly the published packages' archives, and
// each archive must be the package and version it claims to be. Packages
// publish in dependency order and are skipped when VERSION is already on npm,
// so a failed release job can be re-run. With --dry-run, archives go through
// `npm publish --dry-run`, or `npm pack --dry-run` when already on npm.

import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { publishedPackages, versionedPackages, workspaceRoot } from "./packages.mjs";

// npm documents no limit, but the registry has refused a 230 MB archive with
// 413 Payload Too Large. Leave a wide margin.
const maximumArchiveBytes = 100 * 1024 * 1024;

function fail(message) {
  console.error(`publish: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [version, archiveArgument, ...rest] = args.filter((arg) => arg !== "--dry-run");
if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || !archiveArgument || rest.length) {
  fail("usage: publish.mjs VERSION ARCHIVES [--dry-run]");
}

const root = workspaceRoot();
const archives = resolve(archiveArgument);

for (const { name, directory } of versionedPackages(root)) {
  const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
  if (manifest.version !== version) fail(`${name} is at ${manifest.version}, not ${version}`);
}

const packages = publishedPackages(root);
const expected = packages.map(({ tarball }) => tarball).sort();
const actual = readdirSync(archives).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  fail(`${archives} holds ${actual.join(", ") || "nothing"}, expected ${expected.join(", ")}`);
}

for (const { name, tarball } of packages) {
  const archive = join(archives, tarball);
  const manifest = JSON.parse(
    execFileSync("tar", ["--extract", "--gzip", "--to-stdout", "--file", archive, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  if (manifest.name !== name || manifest.version !== version) {
    fail(`${tarball} contains ${manifest.name}@${manifest.version}, not ${name}@${version}`);
  }
  const { size } = statSync(archive);
  if (size > maximumArchiveBytes) fail(`${tarball} is ${size} bytes, over ${maximumArchiveBytes}`);
  console.log(`${name}@${version}: ${tarball}, ${(size / 1024 / 1024).toFixed(1)} MiB`);
}

function published(name) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() === version;
}

for (const { name, tarball } of packages) {
  const archive = join(archives, tarball);
  let command = ["publish", archive, "--access", "public"];
  if (published(name)) {
    console.log(`${name}@${version} is already published`);
    if (!dryRun) continue;
    // npm refuses even a dry-run publish over an existing version.
    command = ["pack", archive];
  }
  if (dryRun) command.push("--dry-run");
  console.log(`$ npm ${command.join(" ")}`);
  execFileSync("npm", command, { stdio: "inherit" });
}

#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const bump = process.argv[2];
if (!["major", "minor", "patch"].includes(bump)) {
  console.error("usage: pnpm release <major|minor|patch>");
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  return execFileSync(command, args, { encoding: "utf8", stdio: "inherit", ...options });
}

function output(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function nextVersion(version, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) fail(`unsupported version ${JSON.stringify(version)}`);
  let [, major, minor, patch] = match.map(Number);
  if (kind === "major") [major, minor, patch] = [major + 1, 0, 0];
  if (kind === "minor") [minor, patch] = [minor + 1, 0];
  if (kind === "patch") patch += 1;
  return `${major}.${minor}.${patch}`;
}

if (output("git", ["status", "--porcelain"])) fail("worktree is not clean");
if (output("git", ["branch", "--show-current"]) !== "main") fail("releases must be made from main");

run("git", ["fetch", "origin", "main", "--tags"]);
if (output("git", ["rev-parse", "HEAD"]) !== output("git", ["rev-parse", "origin/main"])) {
  fail("main is not synchronized with origin/main");
}

const workspace = readFileSync("pnpm-workspace.yaml", "utf8");
const packageDirectories = [...workspace.matchAll(/^\s*-\s+([^#\s]+)\s*$/gm)].map((match) => match[1]);
const packages = packageDirectories
  .map((directory) => {
    const path = resolve(directory, "package.json");
    return { path, manifest: JSON.parse(readFileSync(path, "utf8")) };
  })
  .filter(({ manifest }) => typeof manifest.version === "string");

const versions = new Set(packages.map(({ manifest }) => manifest.version));
if (versions.size !== 1) fail(`workspace packages are not in lockstep: ${[...versions].join(", ")}`);
const version = nextVersion([...versions][0], bump);
const tag = `v${version}`;

if (spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`]).status === 0) {
  fail(`tag ${tag} already exists`);
}

const changelogPath = resolve("CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf8");
const heading = "## [Unreleased]";
const headingIndex = changelog.indexOf(heading);
if (headingIndex === -1) fail("CHANGELOG.md has no [Unreleased] heading");
if (changelog.indexOf(heading, headingIndex + heading.length) !== -1) {
  fail("CHANGELOG.md has more than one [Unreleased] heading");
}
const sectionStart = headingIndex + heading.length;
const nextHeading = changelog.slice(sectionStart).search(/^## \[/m);
const sectionEnd = nextHeading === -1 ? changelog.length : sectionStart + nextHeading;
if (!changelog.slice(sectionStart, sectionEnd).trim()) fail("CHANGELOG.md [Unreleased] section is empty");

for (const pkg of packages) {
  pkg.manifest.version = version;
  writeFileSync(pkg.path, `${JSON.stringify(pkg.manifest, null, 2)}\n`);
}

const date = new Date().toISOString().slice(0, 10);
writeFileSync(changelogPath, changelog.replace(heading, `${heading}\n\n## [${version}] - ${date}`));

const changedFiles = ["CHANGELOG.md", ...packages.map(({ path }) => path)];
run("git", ["add", "--", ...changedFiles]);
run("git", ["diff", "--cached", "--check"]);
run("git", ["commit", "-m", `Release ${tag}`]);
run("git", ["tag", "--annotate", tag, "--message", `Release ${tag}`]);

try {
  run("git", ["push", "--atomic", "origin", "HEAD:refs/heads/main", `refs/tags/${tag}`]);
} catch {
  fail(`push failed; the local release commit and ${tag} were kept for recovery`);
}

console.log(`Released ${tag}`);

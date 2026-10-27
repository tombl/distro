#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readManifest, workspacePackages, workspaceRoot } from "./packages.mjs";

function fail(message) {
  console.error(`pack-package: ${message}`);
  process.exit(1);
}

// The default catalog: the indented `name: range` lines under `catalog:`.
function workspaceCatalog(root) {
  const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const block = workspace.match(/^catalog:\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? "";
  const catalog = new Map();
  for (const line of block.split("\n")) {
    const entry = line.match(/^\s+("[^"]+"|'[^']+'|[^:\s]+):\s*(.+?)\s*$/);
    if (entry) catalog.set(entry[1].replace(/^["']|["']$/g, ""), entry[2].replace(/^["']|["']$/g, ""));
  }
  return catalog;
}

function publishedRange(specifier, version) {
  const range = specifier.slice("workspace:".length);
  if (range === "" || range === "*") return version;
  if (range === "^") return `^${version}`;
  if (range === "~") return `~${version}`;
  if (/^[~^]/.test(range)) return range;
  if (/^\d/.test(range)) return range;
  fail(`unsupported workspace range ${JSON.stringify(specifier)}`);
}

function publishManifest(manifest, packages, catalog) {
  const published = structuredClone(manifest);
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
    for (const [name, specifier] of Object.entries(published[field] ?? {})) {
      if (specifier === "catalog:" || specifier === "catalog:default") {
        if (!catalog.has(name)) fail(`${manifest.name} references ${name} missing from the catalog`);
        published[field][name] = catalog.get(name);
        continue;
      }
      if (typeof specifier !== "string" || !specifier.startsWith("workspace:")) continue;
      const dependency = packages.get(name);
      if (!dependency) fail(`${manifest.name} references missing workspace package ${name}`);
      published[field][name] = publishedRange(specifier, dependency.manifest.version);
    }
  }
  if (/"(?:workspace|catalog):/.test(JSON.stringify(published))) {
    fail(`${manifest.name} has an unsupported workspace or catalog reference`);
  }
  return published;
}

function packFiles(directory) {
  const output = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts", directory],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const result = JSON.parse(output);
  if (result.length !== 1) fail(`expected one package from ${directory}`);
  return result[0].files.map(({ path }) => path);
}

function copyPackageFiles(source, destination) {
  for (const path of packFiles(source)) {
    if (path === "package.json") continue;
    const input = resolve(source, path);
    const output = resolve(destination, path);
    if (relative(source, input).startsWith(`..${sep}`)) fail(`package file escapes source: ${path}`);
    mkdirSync(dirname(output), { recursive: true });
    cpSync(input, output, { recursive: true, dereference: true });
  }
}

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const packageArgument = args[0];
if (!packageArgument || (outIndex !== -1 && !args[outIndex + 1])) {
  fail("usage: pack-package.mjs PACKAGE_DIRECTORY [--out ARCHIVE]");
}

const root = workspaceRoot();
const packageDirectory = resolve(process.cwd(), packageArgument);
const packages = workspacePackages(root);
const catalog = workspaceCatalog(root);
const manifest = readManifest(packageDirectory);
const workspacePackage = packages.get(manifest.name);
if (!workspacePackage || workspacePackage.directory !== packageDirectory) {
  fail(`${packageDirectory} is not a package in this workspace`);
}

const temporary = mkdtempSync(join(tmpdir(), "lowland-pack-"));
try {
  const stage = join(temporary, "package");
  mkdirSync(stage);
  copyPackageFiles(packageDirectory, stage);
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(publishManifest(manifest, packages, catalog), null, 2)}\n`);

  for (const name of manifest.bundledDependencies ?? manifest.bundleDependencies ?? []) {
    const dependency = packages.get(name);
    if (!dependency) fail(`${manifest.name} bundles missing workspace package ${name}`);
    const destination = join(stage, "node_modules", ...name.split("/"));
    mkdirSync(destination, { recursive: true });
    copyPackageFiles(dependency.directory, destination);
    writeFileSync(
      join(destination, "package.json"),
      `${JSON.stringify(publishManifest(dependency.manifest, packages, catalog), null, 2)}\n`,
    );
  }

  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary, stage],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    ),
  );
  if (packed.length !== 1) fail(`expected one packed archive for ${manifest.name}`);
  const sourceArchive = join(temporary, packed[0].filename);
  const outputArgument = outIndex === -1 ? packed[0].filename : args[outIndex + 1];
  const outputArchive = isAbsolute(outputArgument)
    ? outputArgument
    : resolve(process.cwd(), outputArgument);
  mkdirSync(dirname(outputArchive), { recursive: true });
  rmSync(outputArchive, { force: true });
  copyFileSync(sourceArchive, outputArchive);
  console.log(`${manifest.name}: ${outputArchive}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

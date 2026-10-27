#!/usr/bin/env node

// The published npm packages. A workspace package is published iff its
// package.json is not `"private": true`; everything that packs, versions,
// validates, publishes or claims packages derives its list from here.
//
//   node scripts/packages.mjs              published packages, in publish order
//   node scripts/packages.mjs --versioned  manifests that carry the release version
//
// Both print JSON arrays of { name, directory, tarball? }, with directories
// relative to the workspace root.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

function fail(message) {
  console.error(`packages: ${message}`);
  process.exit(1);
}

export function workspaceRoot(start = process.cwd()) {
  let root = resolve(start);
  while (!existsSync(join(root, "pnpm-workspace.yaml"))) {
    const parent = dirname(root);
    if (parent === root) fail("could not find pnpm-workspace.yaml");
    root = parent;
  }
  return root;
}

export function readManifest(directory) {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

// Every named workspace package, by name, with its absolute directory.
export function workspacePackages(root) {
  const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const directories = [...workspace.matchAll(/^\s*-\s+([^#\s]+)\s*$/gm)].map((match) => match[1]);
  const packages = new Map();

  for (const directory of directories) {
    const absolute = resolve(root, directory);
    const manifest = readManifest(absolute);
    if (manifest.name) packages.set(manifest.name, { directory: absolute, manifest });
  }
  return packages;
}

// The archive name for a package in .#npm-packages: @scope/name → scope-name.tgz.
export function tarballName(name) {
  return `${name.replace(/^@/, "").replace("/", "-")}.tgz`;
}

function bundled(manifest) {
  return manifest.bundledDependencies ?? manifest.bundleDependencies ?? [];
}

function workspaceDependencies(manifest, packages) {
  const names = new Set();
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const name of Object.keys(manifest[field] ?? {})) if (packages.has(name)) names.add(name);
  }
  return names;
}

// Published packages, each after the published packages it depends on, so a
// release never exposes a version whose dependencies are not on npm yet.
export function publishedPackages(root, packages = workspacePackages(root)) {
  const published = [...packages.values()].filter(({ manifest }) => manifest.private !== true);
  const ordered = [];
  const visiting = new Set();

  function visit({ directory, manifest }) {
    if (ordered.some((pkg) => pkg.name === manifest.name)) return;
    if (visiting.has(manifest.name)) fail(`${manifest.name} is part of a dependency cycle`);
    visiting.add(manifest.name);
    for (const name of workspaceDependencies(manifest, packages)) {
      const dependency = packages.get(name);
      if (dependency.manifest.private === true) {
        if (!bundled(manifest).includes(name)) {
          fail(`${manifest.name} depends on private ${name} without bundling it`);
        }
        continue;
      }
      visit(dependency);
    }
    visiting.delete(manifest.name);
    ordered.push({
      name: manifest.name,
      directory: relative(root, directory),
      tarball: tarballName(manifest.name),
    });
  }

  for (const pkg of published) {
    for (const field of ["version", "description", "license", "homepage", "files"]) {
      if (!pkg.manifest[field]) fail(`published ${pkg.manifest.name} has no ${field}`);
    }
    if (pkg.manifest.repository?.directory !== relative(root, pkg.directory)) {
      fail(`published ${pkg.manifest.name} has a wrong repository.directory`);
    }
    if (!pkg.manifest.engines?.node) fail(`published ${pkg.manifest.name} has no engines.node`);
    visit(pkg);
  }
  return ordered;
}

// The manifests a release versions: the published packages and the private
// packages they bundle, whose manifests ship inside the published archives.
// Every other workspace package is private and must not carry a version, so
// there is nothing for a release to bump or a check to miss.
export function versionedPackages(root, packages = workspacePackages(root)) {
  const names = new Set();
  for (const { name } of publishedPackages(root, packages)) {
    names.add(name);
    for (const dependency of bundled(packages.get(name).manifest)) names.add(dependency);
  }
  for (const [name, { manifest }] of packages) {
    if (!names.has(name) && manifest.version !== undefined) {
      fail(`${name} is neither published nor bundled, so it must not have a version`);
    }
  }
  return [...names].map((name) => ({
    name,
    directory: relative(root, packages.get(name).directory),
  }));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--versioned")) {
    fail("usage: packages.mjs [--versioned]");
  }
  const root = workspaceRoot();
  const list = args[0] === "--versioned" ? versionedPackages(root) : publishedPackages(root);
  process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
}

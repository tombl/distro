// SPDX-License-Identifier: MIT

// Bundles small applications that import different parts of lowland, with
// Vite and with esbuild, and checks which of the package's assets each output
// contains. An application must contain the assets of what it imports and
// nothing else: in particular, the canonical images only with lowland/image.
//
// Vite emits every `new URL("…", import.meta.url)` asset as a file and
// rewrites the URL to it, so an asset is in its output when the file is
// emitted and the JavaScript references it. esbuild emits no such files and
// leaves the URL as written, so an asset is in its output when the JavaScript
// mentions its name. Either way a missing asset is one the output neither
// contains nor references.
//
// It bundles whichever lowland node_modules resolves to: the workspace
// package after `pnpm --filter=lowland build` and `pnpm artifacts`, or the
// packed package in the Nix check.

import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { build as vite } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const output = join(here, "dist");

const ASSETS = {
  kernel: "vmlinux.wasm",
  agent: "agent.img",
  rootfs: "rootfs.erofs",
  builder: "builder.erofs",
} as const;
type Asset = keyof typeof ASSETS;

interface App {
  entry: string;
  /** The assets the output must contain; it must contain no others. */
  assets: readonly Asset[];
  /** Node-only applications are bundled by esbuild for Node alone. */
  node?: boolean;
}

const APPS: Record<string, App> = {
  // The minimal application, without and with lowland/image.
  linux: { entry: "linux.js", assets: ["kernel", "agent"] },
  "linux + image": { entry: "linux-image.js", assets: ["kernel", "agent", "rootfs"] },
  // Each layer on its own, and the layers beneath Linux together.
  machine: { entry: "machine.js", assets: ["kernel"] },
  guest: { entry: "guest.js", assets: ["agent"] },
  browser: { entry: "browser.js", assets: [] },
  "machine + guest + image": {
    entry: "machine-guest-image.js",
    assets: ["kernel", "agent", "rootfs"],
  },
  "image/build": { entry: "build.js", assets: ["kernel", "agent", "builder"], node: true },
};

/** A name as a bundler may emit it: `rootfs.erofs` or `rootfs-<hash>.erofs`. */
function pattern(name: string) {
  const dot = name.lastIndexOf(".");
  const stem = name.slice(0, dot).replace(/[.]/g, "\\.");
  return new RegExp(`(?<![\\w-])${stem}(?:-[\\w-]+)?\\.${name.slice(dot + 1)}(?![\\w])`, "g");
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)));
}

interface Result {
  emitted: Partial<Record<Asset, number>>;
  referenced: Set<Asset>;
  javascript: number;
  workers: number;
}

async function inspect(directory: string): Promise<Result> {
  const result: Result = { emitted: {}, referenced: new Set(), javascript: 0, workers: 0 };
  let text = "";
  for (const file of await files(directory)) {
    if (/(^|\/)worker-[\w-]+\.js$/.test(file)) result.workers++;
    if (file.endsWith(".js")) {
      const contents = await readFile(join(directory, file), "utf8");
      result.javascript += Buffer.byteLength(contents);
      text += contents;
    }
    for (const [asset, name] of Object.entries(ASSETS) as [Asset, string][]) {
      const base = file.split("/").at(-1)!;
      if (base.match(pattern(name))?.[0] === base) {
        result.emitted[asset] = (await stat(join(directory, file))).size;
      }
    }
  }
  for (const [asset, name] of Object.entries(ASSETS) as [Asset, string][]) {
    if (pattern(name).test(text)) result.referenced.add(asset);
  }
  return result;
}

const bundlers = {
  async vite(app: App, outDir: string) {
    await vite({
      configFile: false,
      root: join(here, "apps"),
      logLevel: "error",
      build: {
        outDir,
        emptyOutDir: true,
        rollupOptions: { input: join(here, "apps", app.entry) },
      },
      worker: { format: "es" },
    });
  },
  async esbuild(app: App, outDir: string) {
    await esbuild({
      entryPoints: [join(here, "apps", app.entry)],
      outdir: outDir,
      bundle: true,
      format: "esm",
      platform: app.node ? "node" : "browser",
      target: "es2024",
      logLevel: "error",
    });
  },
};

await rm(output, { recursive: true, force: true });
const failures: string[] = [];
const rows: string[] = [];
const mib = (bytes: number) => `${(bytes / 2 ** 20).toFixed(2)} MiB`;

for (const [name, app] of Object.entries(APPS)) {
  for (const [bundler, bundle] of Object.entries(bundlers)) {
    if (app.node && bundler !== "esbuild") continue;
    const outDir = join(output, `${bundler}-${app.entry.replace(/\.js$/, "")}`);
    await bundle(app, outDir);
    const result = await inspect(outDir);
    const problems: string[] = [];
    for (const asset of Object.keys(ASSETS) as Asset[]) {
      const expected = app.assets.includes(asset);
      const emitted = asset in result.emitted;
      const referenced = result.referenced.has(asset);
      // esbuild never emits URL assets, so only its references count.
      const present = bundler === "vite" ? emitted && referenced : referenced;
      const any = emitted || referenced;
      if (expected && !present) {
        problems.push(`${ASSETS[asset]} missing (emitted ${emitted}, referenced ${referenced})`);
      } else if (!expected && any) {
        problems.push(`${ASSETS[asset]} included (emitted ${emitted}, referenced ${referenced})`);
      }
    }
    // The kernel is useless without the CPU worker that runs it.
    if (bundler === "vite" && app.assets.includes("kernel") && result.workers !== 1) {
      problems.push(`${result.workers} CPU worker chunks instead of 1`);
    }
    const assets = app.assets.map((asset) => ASSETS[asset]).join(", ") || "none";
    const emitted = Object.values(result.emitted).reduce((total, size) => total + size, 0);
    rows.push(
      `| ${name} | ${bundler} | ${assets} | ${problems.length ? "FAIL" : "ok"} | ${mib(result.javascript)} | ${bundler === "vite" ? mib(emitted) : "-"} |`,
    );
    for (const problem of problems) failures.push(`${name} with ${bundler}: ${problem}`);
  }
}

console.log("| application | bundler | assets | result | JavaScript | emitted assets |");
console.log("| --- | --- | --- | --- | --- | --- |");
for (const row of rows) console.log(row);
if (failures.length) {
  console.error(`\n${failures.join("\n")}`);
  process.exitCode = 1;
}

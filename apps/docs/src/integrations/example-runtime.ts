import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { AstroIntegration, ViteUserConfig } from "astro";

type Plugin = Extract<NonNullable<ViteUserConfig["plugins"]>[number], { name: string }>;

// Runnable examples load the published package the way a page without a
// bundler does: from files on the docs origin, through an import map. This
// integration serves those files in development and copies them into the
// build, under a path that changes whenever any of them does.

const packages = ["lowland"];
const virtualId = "virtual:example-runtime";
const prefix = "/_runtime";

interface RuntimePackage {
  name: string;
  dir: string;
  files: string[];
  exports: Record<string, string>;
}

async function findPackage(root: string, name: string): Promise<string> {
  return realpath(join(root, "node_modules", name));
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

// The files npm would publish: everything under the package's `files`, minus
// source maps, which point at sources that are not served.
async function loadPackage(root: string, name: string): Promise<RuntimePackage> {
  const dir = await findPackage(root, name);
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  const files: string[] = [];
  for (const entry of manifest.files as string[]) {
    const path = join(dir, entry);
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new Error(`${name} is missing ${entry}. Build the package and its artifacts first.`);
    }
    const found = info.isDirectory() ? await listFiles(path) : [path];
    files.push(
      ...found.filter((file) => !file.endsWith(".map")).map((file) => relative(dir, file)),
    );
  }
  const exports: Record<string, string> = {};
  for (const [key, target] of Object.entries(
    manifest.exports as Record<string, { default: string }>,
  )) {
    exports[join(name, key).split(sep).join("/")] = target.default.replace(/^\.\//, "");
  }
  return { name, dir, files: files.map((file) => file.split(sep).join("/")).sort(), exports };
}

async function hashPackages(runtime: RuntimePackage[]): Promise<string> {
  const hash = createHash("sha256");
  for (const pkg of runtime) {
    for (const file of pkg.files) {
      hash.update(`${pkg.name}/${file}\0`);
      hash.update(await readFile(join(pkg.dir, file)));
    }
  }
  return hash.digest("hex").slice(0, 12);
}

function importMap(base: string, runtime: RuntimePackage[]) {
  const imports: Record<string, string> = {};
  for (const pkg of runtime) {
    for (const [specifier, target] of Object.entries(pkg.exports)) {
      if (specifier.endsWith("/node")) continue;
      imports[specifier] = `${base}/${pkg.name}/${target}`;
    }
  }
  return { imports };
}

const contentTypes: Record<string, string> = {
  ".js": "text/javascript",
  ".ts": "text/plain",
  ".wasm": "application/wasm",
};

function devServer(root: string): Plugin {
  let runtime: Promise<RuntimePackage[]> | undefined;
  let serving = false;
  const load = () => (runtime ??= Promise.all(packages.map((name) => loadPackage(root, name))));
  return {
    name: "example-runtime",
    configResolved(config) {
      serving = config.command === "serve";
    },
    resolveId(id) {
      if (id === virtualId) return `\0${virtualId}`;
    },
    async load(id) {
      if (id !== `\0${virtualId}`) return;
      const loaded = await load();
      const base = serving ? `${prefix}/dev` : `${prefix}/${await hashPackages(loaded)}`;
      const types = loaded.flatMap((pkg) =>
        pkg.files.filter((file) => file.endsWith(".d.ts")).map((file) => `${pkg.name}/${file}`),
      );
      return [
        `export const base = ${JSON.stringify(base)};`,
        `export const importMap = ${JSON.stringify(importMap(base, loaded))};`,
        `export const typeFiles = ${JSON.stringify(types)};`,
      ].join("\n");
    },
    configureServer(server) {
      server.middlewares.use(`${prefix}/dev`, async (request, response, next) => {
        const path = decodeURIComponent(new URL(request.url ?? "/", "http://dev").pathname);
        const pkg = (await load()).find((candidate) => path.startsWith(`/${candidate.name}/`));
        const file = pkg && path.slice(pkg.name.length + 2);
        if (!pkg || !file || !pkg.files.includes(file)) return next();
        const extension = file.slice(file.lastIndexOf("."));
        response.setHeader("Content-Type", contentTypes[extension] ?? "application/octet-stream");
        response.setHeader("Cache-Control", "no-cache");
        // The kernel's workers start from these files, and a worker only
        // starts on an isolated page if its script is isolated too.
        response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        createReadStream(join(pkg.dir, file)).pipe(response);
      });
    },
  };
}

export function exampleRuntime(): AstroIntegration {
  let root = "";
  return {
    name: "example-runtime",
    hooks: {
      "astro:config:setup": ({ config, updateConfig }) => {
        root = fileURLToPath(config.root);
        updateConfig({ vite: { plugins: [devServer(root)] } });
      },
      "astro:build:done": async ({ dir, logger }) => {
        const runtime = await Promise.all(packages.map((name) => loadPackage(root, name)));
        const out = join(fileURLToPath(dir), prefix, await hashPackages(runtime));
        let count = 0;
        for (const pkg of runtime) {
          for (const file of pkg.files) {
            const target = join(out, pkg.name, file);
            await mkdir(dirname(target), { recursive: true });
            await copyFile(join(pkg.dir, file), target);
            count++;
          }
        }
        logger.info(`copied ${count} package files to ${relative(fileURLToPath(dir), out)}`);
      },
    },
  };
}

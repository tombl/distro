import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { doc, type Document, type LoadResponse } from "@deno/doc";

import type { ReferenceSection } from "./reference-packages";

const require = createRequire(import.meta.url);

function declarationUrl(specifier: string): string {
  const runtime = require.resolve(specifier);
  if (!runtime.endsWith(".js"))
    throw new Error(`Expected a JavaScript entrypoint for ${specifier}`);
  return pathToFileURL(runtime.replace(/\.js$/, ".d.ts")).href;
}

const declarations = new Map(
  [
    "lowland",
    "lowland/browser",
    "lowland/guest",
    "lowland/image",
    "lowland/image/build",
    "lowland/machine",
    "lowland/node",
  ].map((specifier) => [specifier, declarationUrl(specifier)]),
);

function resolve(specifier: string, referrer: string): string {
  const declaration = declarations.get(specifier);
  if (declaration) return declaration;
  return new URL(specifier, referrer).href;
}

async function load(specifier: string): Promise<LoadResponse | undefined> {
  if (!specifier.startsWith("file:")) return { kind: "external", specifier };

  const path = new URL(specifier);
  const candidates = [path, new URL(path.href.replace(/(?<!\.d)\.ts$/, ".d.ts"))];
  for (const candidate of candidates) {
    try {
      return { kind: "module", specifier, content: await readFile(candidate) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function entrypointUrl(specifier: string): string {
  const entrypoint = declarations.get(specifier);
  if (!entrypoint) throw new Error(`No declaration entrypoint for ${specifier}`);
  return entrypoint;
}

// One document for the whole package: the symbols of every public entrypoint,
// in entrypoint order. Subpaths only add names the root entrypoint lacks.
export async function generateReferenceDocs(pkg: ReferenceSection): Promise<Document> {
  const entrypoints = pkg.entrypoints.map(entrypointUrl);
  const documents = await doc(entrypoints, { load, resolve });
  const symbols: Document["symbols"] = [];
  const seen = new Set<string>();
  for (const [index, entrypoint] of entrypoints.entries()) {
    const document = documents[entrypoint];
    if (!document) throw new Error(`@deno/doc did not return ${pkg.entrypoints[index]}`);
    for (const symbol of document.symbols) {
      if (seen.has(symbol.name)) continue;
      seen.add(symbol.name);
      symbols.push(symbol);
    }
  }
  return { ...documents[entrypoints[0]], symbols };
}

function sourceLabel(specifier: string): string {
  for (const [name, declaration] of declarations) {
    const directory = new URL("./", declaration).href;
    if (specifier.startsWith(directory)) return `${name}/${specifier.slice(directory.length)}`;
  }
  return new URL(specifier).pathname.split("/").at(-1) ?? specifier;
}

export async function generateReferenceMarkdown(pkg: ReferenceSection): Promise<string> {
  const entrypoints = pkg.entrypoints.map(entrypointUrl);
  const entrypoint = entrypoints[0];

  const sources = new Map<string, string>();
  await doc(entrypoints, {
    resolve,
    async load(specifier) {
      const response = await load(specifier);
      if (response?.kind === "module") {
        const content =
          typeof response.content === "string"
            ? response.content
            : new TextDecoder().decode(response.content);
        sources.set(specifier, content.trim());
      }
      return response;
    },
  });

  const modules = [...sources]
    .toSorted(
      ([a], [b]) =>
        Number(entrypoints.includes(b)) - Number(entrypoints.includes(a)) ||
        Number(b === entrypoint) - Number(a === entrypoint) ||
        a.localeCompare(b),
    )
    .flatMap(([specifier, source]) => [
      `## ${sourceLabel(specifier)}`,
      "",
      "```ts",
      source,
      "```",
      "",
    ]);
  return [
    `# ${pkg.name} reference`,
    "",
    `> ${pkg.description}`,
    "",
    "These are the TypeScript declarations used to generate the human-readable reference.",
    "",
    ...modules,
  ].join("\n");
}

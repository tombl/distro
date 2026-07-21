import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { doc, type Document, type LoadResponse } from "@deno/doc";

import type { ReferencePackage } from "./reference-packages";

const require = createRequire(import.meta.url);

function declarationUrl(specifier: string): string {
  const runtime = require.resolve(specifier);
  if (!runtime.endsWith(".js"))
    throw new Error(`Expected a JavaScript entrypoint for ${specifier}`);
  return pathToFileURL(runtime.replace(/\.js$/, ".d.ts")).href;
}

const linuxDeclaration = declarationUrl("@tombl/linux");
const declarations = new Map([
  ["@tombl/linux", linuxDeclaration],
  ["@tombl/linux/bytes", new URL("bytes.d.ts", linuxDeclaration).href],
  ["@tombl/linux-guest", declarationUrl("@tombl/linux-guest")],
]);

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

export async function generateReferenceDocs(pkg: ReferencePackage): Promise<Document> {
  const entrypoint = declarations.get(pkg.name);
  if (!entrypoint) throw new Error(`No declaration entrypoint for ${pkg.name}`);

  const documents = await doc([entrypoint], { load, resolve });
  const document = documents[entrypoint];
  if (!document) throw new Error(`@deno/doc did not return ${pkg.name}`);
  return document;
}

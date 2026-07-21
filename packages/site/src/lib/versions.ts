// Package versions read at build time from the installed workspace packages,
// so code samples and the homepage badge always name the versions this site
// was actually built against.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

async function versionOf(spec: string): Promise<string> {
  const entry = createRequire(import.meta.url).resolve(spec);
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", pathToFileURL(entry)), "utf8"),
  ) as { version: string };
  return pkg.version;
}

export const linuxVersion = await versionOf("@tombl/linux");
export const guestVersion = await versionOf("@tombl/linux-guest");

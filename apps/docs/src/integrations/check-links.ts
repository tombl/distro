import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { AstroIntegration } from "astro";

// Fails the build when a generated page links to a file or anchor on this
// site that the build did not produce, such as a page that is still a draft.
export function checkLinks(site: string): AstroIntegration {
  return {
    name: "check-links",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const root = fileURLToPath(dir);
        // Every generated file, by its URL path.
        const files = new Set(
          (await listFiles(root)).map((file) => `/${relative(root, file).split("\\").join("/")}`),
        );
        const html = new Map<string, string>();
        for (const path of files) {
          if (path.endsWith(".html")) html.set(path, await readFile(join(root, path), "utf8"));
        }

        const broken: string[] = [];
        for (const [file, source] of html) {
          const page = file.replace(/index\.html$/, "");
          for (const [, href] of source.matchAll(/\bhref="([^"]+)"/g)) {
            const target = internalTarget(href.replaceAll("&amp;", "&"), page, site);
            if (!target) continue;
            const resolved = resolveFile(target.path, files);
            if (!resolved) {
              broken.push(`${page}: ${href} (no such file)`);
              continue;
            }
            const linked = html.get(resolved);
            if (target.hash && linked !== undefined && !hasAnchor(linked, target.hash)) {
              broken.push(`${page}: ${href} (no such anchor)`);
            }
          }
        }

        if (broken.length > 0) {
          for (const link of broken) logger.error(link);
          throw new Error(`${broken.length} broken internal links`);
        }
      },
    },
  };
}

// A URL path names a generated file directly, or a directory whose
// index.html is the page.
function resolveFile(path: string, files: Set<string>): string | undefined {
  if (path.endsWith("/")) return files.has(`${path}index.html`) ? `${path}index.html` : undefined;
  if (files.has(path)) return path;
  if (files.has(`${path}/index.html`)) return `${path}/index.html`;
  return undefined;
}

function hasAnchor(html: string, id: string): boolean {
  const escaped = id.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return html.includes(`id="${id}"`) || html.includes(`id="${escaped}"`);
}

function internalTarget(href: string, page: string, site: string) {
  let url: URL;
  try {
    url = new URL(href, new URL(page, site));
  } catch {
    return undefined;
  }
  if (url.origin !== new URL(site).origin) return undefined;
  return { path: decode(url.pathname), hash: decode(url.hash.slice(1)) };
}

// Percent-decodes as browsers do: valid escapes become bytes and a stray
// "%" stays literal, so "#café-100%complete" still matches its id.
function decode(value: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < value.length; i++) {
    const escape = value.slice(i + 1, i + 3);
    if (value[i] === "%" && /^[0-9a-f]{2}$/i.test(escape)) {
      bytes.push(Number.parseInt(escape, 16));
      i += 2;
    } else {
      bytes.push(...encoder.encode(value[i]));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }
  return files;
}

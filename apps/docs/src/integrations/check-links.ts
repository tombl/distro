import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { AstroIntegration } from "astro";

// Fails the build when a generated page links to a page or anchor on this
// site that the build did not produce, such as a page that is still a draft.
export function checkLinks(site: string): AstroIntegration {
  return {
    name: "check-links",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const root = fileURLToPath(dir);
        const pages = new Map<string, string>();
        for (const file of await htmlFiles(root)) {
          const path = `/${relative(root, file)}`.replace(/index\.html$/, "");
          pages.set(path, await readFile(file, "utf8"));
        }

        const broken: string[] = [];
        for (const [page, html] of pages) {
          for (const [, href] of html.matchAll(/\bhref="([^"]+)"/g)) {
            const target = internalTarget(href.replaceAll("&amp;", "&"), page, site);
            if (!target) continue;
            const linked = pages.get(target.path);
            if (linked === undefined) {
              if (!target.path.endsWith("/") || target.path.includes(".")) continue;
              broken.push(`${page}: ${href} (no such page)`);
            } else if (target.hash && !linked.includes(`id="${target.hash}"`)) {
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

function internalTarget(href: string, page: string, site: string) {
  let url: URL;
  try {
    url = new URL(href, new URL(page, site));
  } catch {
    return undefined;
  }
  if (url.origin !== new URL(site).origin) return undefined;
  return { path: url.pathname, hash: decodeURIComponent(url.hash.slice(1)) };
}

async function htmlFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await htmlFiles(path)));
    else if (entry.name.endsWith(".html")) files.push(path);
  }
  return files;
}

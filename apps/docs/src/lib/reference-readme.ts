import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createMarkdownProcessor } from "@astrojs/markdown-remark";

import type { ReferenceSection } from "./reference-packages";

const processor = createMarkdownProcessor({
  syntaxHighlight: "shiki",
  shikiConfig: {
    themes: { light: "github-light-default", dark: "github-dark-default" },
  },
});

export function readPackageReadme(pkg: ReferenceSection): Promise<string> {
  // The package README introduces its own section, and the description the
  // others. Astro runs from apps/docs; the package lives beside it.
  if (!pkg.readme) return Promise.resolve(`# ${pkg.name}\n\n${pkg.description}\n`);
  return readFile(resolve("../../packages/lowland/README.md"), "utf8");
}

// The README introduces the section on its reference page. Its title is
// replaced by the page's own h1, so the leading comment and h1 are dropped.
export async function renderPackageReadme(pkg: ReferenceSection) {
  const source = (await readPackageReadme(pkg))
    .replace(/^\s*<!--[\s\S]*?-->\s*/, "")
    .replace(/^#\s.*\n/, "");
  const { code, metadata } = await (await processor).render(source);
  return { html: code, headings: metadata.headings };
}

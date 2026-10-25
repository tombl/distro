import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createMarkdownProcessor } from "@astrojs/markdown-remark";

import type { ReferencePackage } from "./reference-packages";

const processor = createMarkdownProcessor({
  syntaxHighlight: "shiki",
  shikiConfig: {
    themes: { light: "github-light-default", dark: "github-dark-default" },
  },
});

export function readPackageReadme(pkg: ReferencePackage): Promise<string> {
  // Astro runs from apps/docs; package sources live beside it in the workspace.
  return readFile(resolve("../../packages", pkg.directory, "README.md"), "utf8");
}

// The README introduces the package on its reference page. Its title is
// replaced by the page's own h1, so the leading comment and h1 are dropped.
export async function renderPackageReadme(pkg: ReferencePackage) {
  const source = (await readPackageReadme(pkg))
    .replace(/^\s*<!--[\s\S]*?-->\s*/, "")
    .replace(/^#\s.*\n/, "");
  const { code, metadata } = await (await processor).render(source);
  return { html: code, headings: metadata.headings };
}

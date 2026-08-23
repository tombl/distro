import { unified } from "@astrojs/markdown-remark";
import mdx from "@astrojs/mdx";
import { defineConfig } from "astro/config";

// External links in rendered markdown open in a new tab; the global
// a[target="_blank"]::after rule then annotates them with an arrow.
function externalLinkTargets() {
  return (tree: unknown) => {
    (function walk(node: any): void {
      if (node?.tagName === "a" && /^https?:/.test(String(node.properties?.href ?? ""))) {
        node.properties.target = "_blank";
      }
      for (const child of node?.children ?? []) walk(child);
    })(tree);
  };
}

export default defineConfig({
  site: "https://docs.low.land",
  markdown: {
    syntaxHighlight: "shiki",
    shikiConfig: {
      themes: {
        light: "github-light-default",
        dark: "github-dark-default",
      },
    },
    processor: unified({ rehypePlugins: [externalLinkTargets] }),
  },
  integrations: [
    mdx({
      optimize: {
        ignoreElementNames: ["pre"],
      },
    }),
  ],
  vite: {
    server: {
      allowedHosts: ["lowland-docs.via.tombl.net"],
    },
  },
});

import { unified } from "@astrojs/markdown-remark";
import mdx from "@astrojs/mdx";
import { defineConfig } from "astro/config";

import { checkLinks } from "./src/integrations/check-links";

// External links in rendered markdown open in a new tab.
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

const site = "https://docs.low.land";

export default defineConfig({
  site,
  markdown: {
    syntaxHighlight: "shiki",
    shikiConfig: {
      themes: {
        light: "github-light-default",
        dark: "github-dark-default",
      },
    },
    processor: unified({ smartypants: false, rehypePlugins: [externalLinkTargets] }),
  },
  integrations: [
    checkLinks(site),
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

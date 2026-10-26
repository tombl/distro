import { unified } from "@astrojs/markdown-remark";
import mdx from "@astrojs/mdx";
import { defineConfig } from "astro/config";

import { checkLinks } from "./src/integrations/check-links";
import { exampleRuntime } from "./src/integrations/example-runtime";
import { runnableExamples } from "./src/integrations/runnable-examples";

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
    processor: unified({
      smartypants: false,
      remarkPlugins: [runnableExamples],
      rehypePlugins: [externalLinkTargets],
    }),
  },
  integrations: [
    checkLinks(site),
    exampleRuntime(),
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
    // The examples' type checker loads its standard library in chunks.
    worker: {
      format: "es",
    },
  },
  // Runnable examples boot machines, which need shared memory, so every page
  // is cross-origin isolated. public/_headers sends the same in production.
  server: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
});

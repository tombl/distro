import { unified } from "@astrojs/markdown-remark";
import mdx from "@astrojs/mdx";
import { defineConfig, fontProviders } from "astro/config";

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

type LocalVariant = {
  src: [string];
  weight: number;
  style: "normal" | "italic";
};

function fontsourceVariants(
  family: string,
  weights: [number, ...number[]],
): [LocalVariant, ...LocalVariant[]] {
  return weights.flatMap((weight) =>
    (["normal", "italic"] as const).map((style) => ({
      src: [`@fontsource/${family}/files/${family}-latin-${weight}-${style}.woff2`],
      weight,
      style,
    })),
  ) as [LocalVariant, ...LocalVariant[]];
}

export default defineConfig({
  markdown: {
    syntaxHighlight: false,
    processor: unified({ rehypePlugins: [externalLinkTargets] }),
  },
  fonts: [
    {
      provider: fontProviders.local(),
      name: "Adwaita Sans",
      cssVariable: "--font-sans",
      weights: [400, 500, 600, 700],
      fallbacks: ["system-ui", "sans-serif"],
      options: {
        variants: fontsourceVariants("adwaita-sans", [400, 500, 600, 700]),
      },
    },
    {
      provider: fontProviders.local(),
      name: "Adwaita Mono",
      cssVariable: "--font-mono",
      weights: [400, 700],
      fallbacks: ["ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
      options: {
        variants: fontsourceVariants("adwaita-mono", [400, 700]),
      },
    },
  ],
  integrations: [
    mdx({
      optimize: {
        ignoreElementNames: ["pre"],
      },
    }),
  ],
  server: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  },
});

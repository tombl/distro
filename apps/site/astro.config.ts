import { defineConfig, fontProviders } from "astro/config";

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
  site: "https://low.land",
  compressHTML: false,
  build: {
    inlineStylesheets: "never",
  },
  fonts: [
    {
      provider: fontProviders.local(),
      name: "Adwaita Sans",
      cssVariable: "--font-sans",
      weights: [400, 500, 600, 700],
      fallbacks: ["system-ui", "sans-serif"],
      options: { variants: fontsourceVariants("adwaita-sans", [400, 500, 600, 700]) },
    },
    {
      provider: fontProviders.local(),
      name: "Adwaita Mono",
      cssVariable: "--font-mono",
      weights: [400, 700],
      fallbacks: ["ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
      options: { variants: fontsourceVariants("adwaita-mono", [400, 700]) },
    },
  ],
  vite: {
    server: {
      allowedHosts: ["lowland-astro.via.tombl.net"],
    },
    worker: {
      format: "es",
    },
    build: {
      target: "esnext",
      minify: false,
      cssMinify: false,
      sourcemap: false,
      assetsInlineLimit: 0,
      modulePreload: { polyfill: false },
      rolldownOptions: {
        output: {
          entryFileNames: "_astro/[name]-[hash].js",
          chunkFileNames: "_astro/[name]-[hash].js",
          assetFileNames: "_astro/[name]-[hash][extname]",
          codeSplitting: {
            groups: [
              {
                name: "bytes",
                test: /[\\/]packages[\\/]bytes[\\/]/,
                priority: 40,
              },
              {
                name: "kernel",
                test: /[\\/]packages[\\/]kernel[\\/]/,
                priority: 35,
              },
              {
                name: "linux-guest",
                test: /[\\/]packages[\\/]linux-guest[\\/]/,
                priority: 30,
              },
              {
                name: "xterm",
                test: /[\\/]node_modules[\\/].*@xterm[\\/]/,
                priority: 25,
              },
              {
                name: "bridge",
                test: /[\\/]packages[\\/]bridge-site[\\/]/,
                priority: 20,
              },
            ],
          },
        },
      },
    },
  },
  server: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  },
});

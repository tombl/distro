import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://low.land",
  compressHTML: false,
  build: {
    inlineStylesheets: "never",
  },
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

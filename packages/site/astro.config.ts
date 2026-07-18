import { defineConfig } from "astro/config";

export default defineConfig({
  server: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  },
  vite: {
    server: {
      fs: {
        allow: ["/home/tom/src/distro"], // TODO: remove
      },
    },
  },
});

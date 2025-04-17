import { defineConfig } from "vite";

export default defineConfig({
  server: {
    fs: {
      allow: ["..", "/nix/store"],
    },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  },
});

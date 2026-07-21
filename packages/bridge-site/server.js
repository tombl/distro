#!/usr/bin/env node
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "public");

const MAIN_PORT = 4181;
const BRIDGE_PORT = 4180;
// The rendezvous hub origin the VM page derives its guest family from. Guests
// are this origin with the "hub" label swapped for a port.
const HUB_ORIGIN = `http://hub.bridge.localhost:${BRIDGE_PORT}`;

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

// Bridge origin: the static files from public/. bridge.html and bridge.js need
// CORP so the COEP main page can embed the iframe. On Cloudflare that comes
// from public/_headers; here the server sets it (mirrors those rules).
const bridge = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, HUB_ORIGIN).pathname);
  let relative = normalize(pathname === "/" ? "index.html" : pathname.slice(1));
  let path = join(publicDir, relative);
  if (!path.startsWith(`${publicDir}/`)) return void response.writeHead(403).end();
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
  } catch {
    // Any other path is the not-connected page, mirroring Cloudflare Pages'
    // SPA fallback: before the worker installs, every navigation lands here.
    relative = "index.html";
    path = join(publicDir, relative);
  }
  const headers = {
    "Content-Type": types[extname(path)] ?? "application/octet-stream",
  };
  if (
    relative === "_bridge/bridge.html" ||
    relative === "_bridge/bridge.js" ||
    relative === "_bridge/provider.html" ||
    relative === "_bridge/requester.html"
  ) {
    headers["Cross-Origin-Resource-Policy"] = "cross-origin";
    headers["Cross-Origin-Embedder-Policy"] = "require-corp";
  }
  response.writeHead(200, headers);
  createReadStream(path).pipe(response);
});
bridge.listen(BRIDGE_PORT, "127.0.0.1");

// Main origin: the cross-origin-isolated page that hosts the VM. It embeds the
// bridge with a stub handler that echoes the request and streams its body back.
const clientJs = readFileSync(join(here, "client.js"));
const mainPage = `<!doctype html>
<meta charset="utf-8" />
<title>bridge test</title>
<script type="module">
  import { serveGuest } from "/client.js";
  // One VM page, every guest origin in the family bound lazily on first demand.
  // The stub echoes the demanded port so tests can assert the origin->port map.
  const bridge = serveGuest({
    hub: ${JSON.stringify(HUB_ORIGIN)},
    fetch: (port) => async (request) => {
      const url = new URL(request.url);
      // A magic path the GUEST_ERROR test hits: the handler throwing is exactly
      // how a real guest with nothing listening on its port surfaces.
      if (url.pathname === "/boom") throw new Error("nothing listening on guest port " + port);
      const info = JSON.stringify({
        port,
        path: url.pathname + url.search,
        method: request.method,
        body: new TextDecoder().decode(await request.arrayBuffer()),
      });
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(info));
          controller.enqueue(encoder.encode("::chunk::"));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "application/json", "x-bridge-stub": "yes" },
      });
    },
  });
  globalThis.closeBridge = () => bridge.close();
  globalThis.iframeCount = () => document.querySelectorAll("iframe").length;
</script>
`;

// The guest.spec.js page: boots a real VM, so it also needs the built packages
// and the nix-built guest images (scripts/prepare-assets.sh populates .assets).
const vmPage = readFileSync(join(here, "tests", "vm.html"));
const assetsDir = join(here, ".assets");

const main = createServer((request, response) => {
  const headers = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  };
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  if (pathname === "/client.js") {
    response.writeHead(200, { ...headers, "Content-Type": types[".js"] }).end(clientJs);
    return;
  }
  if (pathname === "/vm.html") {
    response.writeHead(200, { ...headers, "Content-Type": types[".html"] }).end(vmPage);
    return;
  }
  const path =
    pathname === "/initramfs.cpio" || pathname === "/rootfs.squashfs"
      ? join(assetsDir, pathname.slice(1))
      : pathname.startsWith("/node_modules/")
        ? join(here, normalize(pathname.slice(1)))
        : null;
  if (path !== null) {
    if (!path.startsWith(`${here}/`)) return void response.writeHead(403).end();
    try {
      if (!statSync(path).isFile()) throw new Error("not a file");
    } catch {
      return void response.writeHead(404).end();
    }
    response.writeHead(200, {
      ...headers,
      "Content-Type": types[extname(path)] ?? "application/octet-stream",
    });
    createReadStream(path).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, "Content-Type": types[".html"] }).end(mainPage);
});
main.listen(MAIN_PORT, "127.0.0.1");

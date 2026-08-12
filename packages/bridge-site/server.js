#!/usr/bin/env node
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "public");

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

// Bridge origin: the static files from public/. The frame documents need CORP
// so the COEP main page can embed them; production hosts must set the same
// headers described in readme.md.
let hubOrigin;
const bridge = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, hubOrigin).pathname);
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

const bridgePort = await listen(bridge);
// The rendezvous hub origin the VM page derives its guest family from. Guests
// are this origin with the "hub" label swapped for a port.
hubOrigin = `http://hub.bridge.localhost:${bridgePort}`;
console.log(`Bridge listening on ${hubOrigin}`);

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
    hub: ${JSON.stringify(hubOrigin)},
    fetch: (port) => async (request) => {
      const url = new URL(request.url);
      // A magic path the guest-error test hits: throwing is how a real guest
      // with nothing listening on its port surfaces.
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
  globalThis.bridgeOrigin = ${JSON.stringify(hubOrigin)};
  globalThis.iframeCount = () => document.querySelectorAll("iframe").length;
</script>
`;

// The guest.spec.js page: boots a real VM, so it also needs the built packages
// and the guest images that `pnpm artifacts` materializes into their owning
// packages (here, @tombl/linux-guest's rootfs.erofs).
const vmPage = readFileSync(join(here, "tests", "vm.html"), "utf8").replaceAll(
  "__HUB_ORIGIN__",
  hubOrigin,
);
const guestRootfs = join(here, "node_modules/@tombl/linux-guest/rootfs.erofs");

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
    pathname === "/rootfs.erofs"
      ? guestRootfs
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
const mainPort = await listen(main);
console.log(`Listening on http://main.bridge.localhost:${mainPort}`);

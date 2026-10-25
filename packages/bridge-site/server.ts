import { createReadStream, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { testAsset } from "../../scripts/test-assets.ts";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "public");

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

// Bridge origin: the static files from public/. The frame documents need CORP
// so the COEP main page can embed them; production hosts must set the same
// headers described in readme.md.
const bridge = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
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
  const headers: Record<string, string> = {
    "Content-Type": types[extname(path)] ?? "application/octet-stream",
  };
  if (
    relative === "_bridge/bridge.html" ||
    relative === "_bridge/bridge.js" ||
    relative === "_bridge/provider.html" ||
    relative === "_bridge/provider.js" ||
    relative === "_bridge/requester.html" ||
    relative === "_bridge/requester.js"
  ) {
    headers["Cross-Origin-Resource-Policy"] = "cross-origin";
    headers["Cross-Origin-Embedder-Policy"] = "require-corp";
  }
  response.writeHead(200, headers);
  createReadStream(path).pipe(response);
});

function listen(server: Server) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

const bridgePort = await listen(bridge);
// The rendezvous hub origin the VM page derives its guest family from. Guests
// are this origin with the "hub" label swapped for a port.
const hubOrigin = `http://hub.bridge.localhost:${bridgePort}`;
console.log(`Bridge listening on ${hubOrigin}`);

// Main origin: the cross-origin-isolated page that hosts the VM. It embeds the
// bridge with a stub handler, tests/pages/stub.ts.
const clientJs = readFileSync(join(here, "client.js"));
const importMap = JSON.stringify({ imports: { "@lowland/bridge-site/client": "/client.js" } });
const mainPage = `<!doctype html>
<meta charset="utf-8" />
<title>bridge test</title>
<meta name="hub" content="${hubOrigin}" />
<script type="importmap">${importMap}</script>
<script type="module" src="/pages/stub.js"></script>
`;

// The guest.spec.ts page: boots a real VM, so it also needs the built workspace
// packages and the guest root image from the test assets.
const vmPage = readFileSync(join(here, "tests/pages/vm.html"), "utf8").replaceAll(
  "__HUB_ORIGIN__",
  hubOrigin,
);

// The test pages are TypeScript; esbuild strips the types as they are served.
async function page(name: string) {
  const path = join(here, "tests/pages", `${name}.ts`);
  const { code } = await transform(await readFile(path, "utf8"), {
    loader: "ts",
    sourcefile: path,
    target: "es2024",
  });
  return code;
}

const main = createServer(async (request, response) => {
  const headers = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  };
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  const script = /^\/pages\/([\w-]+)\.js$/.exec(pathname);
  if (script) {
    let code;
    try {
      code = await page(script[1]!);
    } catch {
      return void response.writeHead(404).end();
    }
    response.writeHead(200, { ...headers, "Content-Type": types[".js"] }).end(code);
    return;
  }
  if (pathname === "/client.js") {
    response.writeHead(200, { ...headers, "Content-Type": types[".js"] }).end(clientJs);
    return;
  }
  if (pathname === "/vm.html") {
    response.writeHead(200, { ...headers, "Content-Type": types[".html"] }).end(vmPage);
    return;
  }
  if (pathname === "/rootfs.erofs") {
    let path;
    try {
      path = await testAsset("rootfs.erofs");
    } catch (error) {
      console.error(
        "failed to build rootfs.erofs:",
        (error as { stderr?: string }).stderr ?? error,
      );
      return void response.writeHead(500).end();
    }
    try {
      if (!statSync(path).isFile()) throw new Error("not a file");
    } catch {
      return void response.writeHead(404).end();
    }
    response.writeHead(200, { ...headers, "Content-Type": "application/octet-stream" });
    createReadStream(path).pipe(response);
    return;
  }
  if (pathname.startsWith("/node_modules/")) {
    const path = join(here, normalize(pathname.slice(1)));
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

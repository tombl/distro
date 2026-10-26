import { createReadStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { testAsset, testAssets } from "../../scripts/test-assets.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const types = {
  ".cpio": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".erofs": "application/octet-stream",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// `node server.js` serves this package: the scenario page, the workspace
// packages it imports, and the Nix-built images it boots. `node server.js
// --site` serves the deployed site from the test assets instead.
const site = process.argv.includes("--site");

const assets = new Set([
  "boot.cpio",
  "opfs-disk-worker.js",
  "posix-spawn-stress.erofs",
  "remote-vm.erofs",
  "rootfs.erofs",
  "scheduler-handoff.erofs",
]);

// Production and previews fetch the independently published repository. The
// site test serves the exact candidate repository so it can validate an
// install before those packages have reached production. After installation
// the service worker controls the page, so Playwright's page-level route
// cannot intercept guest fetches: the served worker routes only package
// requests to the candidate repository, and still fetches other assets
// from assets.low.land directly.
async function siteServiceWorker() {
  const source = await readFile(await testAsset("site/service-worker.js"), "utf8");
  const patched = source
    .replace("  const { request } = event;", "  let { request } = event;")
    .replace(
      "  const url = new URL(request.url);",
      `  let url = new URL(request.url);
  if (url.hostname === "assets.low.land" && url.pathname.startsWith("/apk/")) {
    request = new Request(new URL(url.pathname + url.search, location.origin), request);
    url = new URL(request.url);
  }`,
    );
  if (
    !patched.includes('url.hostname === "assets.low.land"') ||
    !patched.includes("let { request }")
  ) {
    throw new Error("the site's service worker no longer matches the test's routing patch");
  }
  return patched;
}

// Resolves a request path to a file, or to generated contents.
async function resolve(relative) {
  if (site) {
    if (relative === "service-worker.js") return { contents: await siteServiceWorker() };
    const directory = await testAssets();
    return relative.startsWith("apk/")
      ? join(directory, relative)
      : join(directory, "site", relative);
  }
  if (assets.has(relative)) return testAsset(relative);
  if (relative === "service-worker.js") return join(here, "../../apps/site/service-worker.js");
  return join(here, relative);
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const isolation = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const relative = normalize(pathname === "/" ? "index.html" : pathname.slice(1));
  if (relative.startsWith("..") || relative.startsWith("/")) {
    response.writeHead(403).end();
    return;
  }
  let path;
  try {
    path = await resolve(relative);
  } catch (error) {
    console.error(`failed to resolve ${relative}:`, error.stderr ?? error);
    response.writeHead(500).end();
    return;
  }
  if (typeof path === "object") {
    response.writeHead(200, { "Content-Type": types[extname(relative)], ...isolation });
    response.end(path.contents);
    return;
  }
  if (!isFile(path)) {
    response.writeHead(404).end();
    return;
  }
  const { size } = statSync(path);
  const type = types[extname(path)] ?? "application/octet-stream";
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (!range && size === 0) {
    response.writeHead(200, {
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      "Content-Length": 0,
      ...isolation,
    });
    response.end();
    return;
  }
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] !== "" ? Number(range[2]) : size - 1;
  if (start < 0 || end < start || end >= size) {
    response.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
    return;
  }
  response.writeHead(range ? 206 : 200, {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    ...isolation,
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(path, { start, end }).pipe(response);
});

server.listen(0, "127.0.0.1", () => {
  console.log(`Listening on http://127.0.0.1:${server.address().port}`);
});

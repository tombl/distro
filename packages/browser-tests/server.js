import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const types = {
  ".cpio": "application/octet-stream",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".squashfs": "application/octet-stream",
  ".wasm": "application/wasm",
};

const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const relative = normalize(pathname === "/" ? "index.html" : pathname.slice(1));
  const path = join(root, relative);
  if (!path.startsWith(`${root}/`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
  } catch {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": types[extname(path)] ?? "application/octet-stream",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
  createReadStream(path).pipe(response);
});

server.listen(4173, "127.0.0.1");

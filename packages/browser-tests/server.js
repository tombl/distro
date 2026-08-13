import { execFile } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = process.cwd();
const types = {
  ".cpio": "application/octet-stream",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".erofs": "application/octet-stream",
  ".wasm": "application/wasm",
};

// The guest root disk and the scheduler-handoff initramfs are nix build
// products: present in the packed suite the checks run against, absent in a
// dev checkout, where we build them ourselves. Same contract as
// packages/linux-guest/tests/assets.ts, including $LINUX_GUEST_TEST_ASSETS.
const built = new Map();
function build(attribute) {
  if (!built.has(attribute)) {
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    built.set(
      attribute,
      promisify(execFile)("nix", [
        "build",
        `${repository}#${attribute}`,
        "--no-link",
        "--print-out-paths",
      ]).then(({ stdout }) => stdout.trim()),
    );
  }
  return built.get(attribute);
}

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const relative = normalize(pathname === "/" ? "index.html" : pathname.slice(1));
  let path = join(root, relative);
  if (!path.startsWith(`${root}/`)) {
    response.writeHead(403).end();
    return;
  }
  const exists = (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (!exists(path)) {
    try {
      if (relative === "rootfs.erofs") {
        const directory =
          process.env.LINUX_GUEST_TEST_ASSETS ?? (await build("linux-guest.checks.tests.assets"));
        path = join(directory, relative);
      } else if (relative === "scheduler-handoff.cpio") {
        path = await build("basic-init.schedulerHandoffInitramfs");
      } else if (relative === "remote-vm.cpio") {
        path = await build("basic-init.remoteMemoryInitramfs");
      } else if (relative === "posix-spawn-stress.cpio") {
        path = await build("basic-init.posixSpawnStressInitramfs");
      }
    } catch (error) {
      console.error(`failed to build ${relative}:`, error.stderr ?? error);
      built.clear();
      response.writeHead(500).end();
      return;
    }
  }
  if (!exists(path)) {
    response.writeHead(404).end();
    return;
  }
  const { size } = statSync(path);
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (!range && size === 0) {
    response.writeHead(200, {
      "Content-Type": types[extname(path)] ?? "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Content-Length": 0,
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
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
    "Content-Type": types[extname(path)] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(path, { start, end }).pipe(response);
});

server.listen(0, "127.0.0.1", () => {
  console.log(`Listening on http://127.0.0.1:${server.address().port}`);
});

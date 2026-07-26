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
  ".squashfs": "application/octet-stream",
  ".wasm": "application/wasm",
};

// The guest assets and the scheduler-handoff initramfs are nix build
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
      if (relative.startsWith("node_modules/@tombl/linux-guest/")) {
        const directory =
          process.env.LINUX_GUEST_TEST_ASSETS ?? (await build("linux-guest.checks.tests.assets"));
        path = join(directory, relative.split("/").at(-1));
      } else if (relative === "scheduler-handoff.cpio") {
        path = await build("basic-init.schedulerHandoffInitramfs");
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
  response.writeHead(200, {
    "Content-Type": types[extname(path)] ?? "application/octet-stream",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
  createReadStream(path).pipe(response);
});

server.listen(0, "127.0.0.1", () => {
  console.log(`Listening on http://127.0.0.1:${server.address().port}`);
});

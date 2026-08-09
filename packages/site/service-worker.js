// SPDX-License-Identifier: MIT

const types = {
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  mjs: "text/javascript; charset=utf-8",
  wasm: "application/wasm",
};

function contentType(name) {
  const extension = name.split(".").at(-1)?.toLowerCase();
  return types[extension] ?? "application/octet-stream";
}

async function bootFile(pathname) {
  const parts = (pathname === "/" ? "index.html" : pathname.slice(1)).split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return undefined;

  let directory = await navigator.storage.getDirectory();
  directory = await directory.getDirectoryHandle("boot");
  for (const part of parts.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(part);
  }
  return await (await directory.getFileHandle(parts.at(-1))).getFile();
}

async function serve(request) {
  const url = new URL(request.url);
  if (
    url.origin !== location.origin ||
    !["GET", "HEAD"].includes(request.method) ||
    url.pathname === "/service-worker.js"
  ) {
    return fetch(request);
  }

  try {
    const file = await bootFile(url.pathname);
    if (!file) return fetch(request);
    return new Response(request.method === "HEAD" ? null : file, {
      headers: {
        "Content-Type": contentType(file.name),
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch (error) {
    if (
      error instanceof DOMException &&
      ["NotFoundError", "TypeMismatchError"].includes(error.name)
    ) {
      return fetch(request);
    }
    throw error;
  }
}

self.addEventListener("fetch", (event) => event.respondWith(serve(event.request)));

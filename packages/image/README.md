# `@lowland/image`

`@lowland/image` is the canonical Lowland system image. It contains BusyBox,
apk-tools, and CA certificates, and apk installs further packages from the
public Lowland repository.

## Installation

```sh
npm install @lowland/kernel @lowland/guest @lowland/image
```

## Usage

```js
import { bootMachine } from "@lowland/kernel";
import { guestAgent } from "@lowland/guest";
import { rootImage } from "@lowland/image";

const guest = guestAgent();
await using machine = await bootMachine({
  cpus: 1,
  plugins: [rootImage(), guest],
});

const result = await guest.run(["uname", "-a"]);
console.log(new TextDecoder().decode(result.stdout));
```

`rootImage()` attaches the image as a read-only block device. The image is an
EROFS filesystem labeled `LOWLAND_ROOT`, which the guest agent finds and mounts
as the root filesystem. Changes to the root filesystem last only for the life
of the machine.

The image ships inside this package and is loaded relative to the module, so
it needs no configuration in Node or browsers. Node reads the file on demand.
Browsers fetch it once and share it between machines.

Bundlers that keep `new URL(..., import.meta.url)` next to the module, such as
Vite production builds, need no configuration either. The Vite 7 development
server moves prebundled dependencies into `node_modules/.vite/deps` without
the image, so the request returns the dev server's HTML fallback and
`bootMachine()` rejects it. Exclude the Lowland packages from dependency
optimization:

```js
// vite.config.js
export default {
  optimizeDeps: {
    exclude: ["@lowland/image", "@lowland/kernel", "@lowland/guest"],
  },
};
```

## Custom images

Pass a source to `rootImage()` to attach your own EROFS or ext4 image instead:

```js
const guest = guestAgent();
await using machine = await bootMachine({
  cpus: 1,
  plugins: [rootImage("app.erofs"), guest],
});
```

In Node, a string is a file path, and `rootImage()` also accepts a `file:` URL
or a `FileHandle` from `node:fs/promises`. Node reads files on demand. In
browsers, a string is a URL relative to the page, and the image is fetched once
and shared between machines. Every platform accepts a `Uint8Array`,
`ArrayBuffer`, `Blob`, or `Response` that holds the whole image.

The guest agent mounts the filesystem labeled `LOWLAND_ROOT` as the root, so a
custom root image needs that label. A source that contains neither an EROFS
nor an ext4 filesystem, or whose size is not a whole number of 512-byte
sectors, fails `bootMachine()` with an error that names it. This catches a
development server that answers a mistyped asset URL with an HTML page.

## Writable images

Images are read-only by default. The guest agent boots a read-only image
beneath a temporary writable overlay, so the guest can still write to its root,
but those changes are discarded when the machine closes and the image itself is
never modified. Pass `writable: true` to let the guest write to an ext4 image
and keep its changes:

```js
const guest = guestAgent();
await using machine = await bootMachine({
  cpus: 1,
  plugins: [rootImage("app.ext4", { writable: true }), guest],
});
```

A path is opened for reading and writing. A `FileHandle` must already be open
for writing, and it stays open after the machine closes. A `Uint8Array` or
`ArrayBuffer` is modified in place. Fetched images, blobs, and responses cannot
be writable. EROFS is always read-only, so `rootImage()` throws for writable
EROFS bytes, and `bootMachine()` rejects a writable EROFS path or `FileHandle`.
Attach a writable image to only one running machine at a time.

The guest decides when its writes reach the image. Data is written once the
guest flushes it, for example by running `sync` or unmounting the filesystem,
so run `sync` in the guest before closing the machine to keep recent changes.

## Installing packages

The image trusts the signing key of the public repository at
`http://assets.low.land/apk/wasm32/Packages.adb` and resolves names through
`nameserver 192.0.2.1`, the host side of a `@lowland/guest` network. Attach a
network as described in the `@lowland/guest` README, then install packages
with apk:

```js
await guest.run(["apk", "add", "curl"]);
```

## Building images

`@lowland/image/build` builds a custom system image in Node. It boots a builder
machine from an image shipped in this package, so it needs no other tools:

```js
import { buildImage } from "@lowland/image/build";

await buildImage({
  packages: ["busybox", "curl"],
  files: {
    "/usr/local/bin/app": { source: "./build/app", mode: "0755" },
  },
  links: { "/usr/bin/app": "/usr/local/bin/app" },
  output: "app.erofs",
});
```

Package names resolve from the public repository with signature checks, and
the builder downloads them through the host network. Paths to local `.apk`
files are installed without signature checks. A build whose packages are all
local files uses no network.

The default format is EROFS, which the guest agent mounts read-only. Pass
`format: "ext4"` for a writable image, with `size` setting its capacity. The
label defaults to `LOWLAND_ROOT`, so the guest agent boots the result. Attach
it with `blockDevice()` from `@lowland/kernel`.

The same build is available from the command line:

```sh
npx @lowland/image build --package busybox --package curl \
  --file ./build/app:/usr/local/bin/app:0755 \
  --link /usr/bin/app=/usr/local/bin/app \
  --output app.erofs
```

## License

The TypeScript and JavaScript sources are available under the MIT license. The
published images also contain GPL-2.0-only BusyBox and apk-tools, MIT-licensed
musl, and the MPL-2.0 Mozilla CA certificate bundle. The builder image also
contains GPL-2.0-only e2fsprogs and GPL-2.0-or-later erofs-utils.

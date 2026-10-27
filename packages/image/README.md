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

const guest = guestAgent({ mounts: [rootImage()] });
await using machine = await bootMachine({ cpus: 1, plugins: [guest] });

const result = await guest.run(["uname", "-a"]);
console.log(new TextDecoder().decode(result.stdout));
```

`rootImage()` is the root entry of the guest agent's mount table: the image,
opened read-only, beneath a temporary writable layer in memory. The image is a
deflate-compressed EROFS filesystem. Changes to the root filesystem last only
for the life of the machine.

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

Pass a source to `rootImage()` to boot your own EROFS or ext4 image instead:

```js
const guest = guestAgent({ mounts: [rootImage("app.erofs")] });
await using machine = await bootMachine({ cpus: 1, plugins: [guest] });
```

In Node, a string is a file path, and `rootImage()` also accepts a `file:` URL
or a `FileHandle` from `node:fs/promises`. Node reads files on demand. In
browsers, a string is a URL relative to the page, and the image is fetched once
and shared between machines. Every platform accepts a `Uint8Array`,
`ArrayBuffer`, `Blob`, or `Response` that holds the whole image.

`rootImage()` reads the superblock of bytes, and of a path in Node, at once: it
throws unless there is an EROFS or ext4 filesystem, whose type the entry then
names. Other sources are read when the machine boots, and the guest tries each
filesystem it supports. A source served as an HTML page, or whose size is not
a whole number of 512-byte sectors, fails `bootMachine()` with an error that
names it. This catches a development server that answers a mistyped asset URL
with an HTML page.

## Writable images

`rootImage()` never changes the image. The guest can still write to its root,
but those changes are discarded when the machine closes. To keep them, mount an
ext4 image writable with a mount entry of your own instead:

```js
const guest = guestAgent({ mounts: [{ path: "/", source: "app.ext4", type: "ext4" }] });
await using machine = await bootMachine({ cpus: 1, plugins: [guest] });
```

A path is opened for reading and writing. A `FileHandle` must already be open
for writing, and it stays open after the machine closes. A `Uint8Array` or
`ArrayBuffer` is modified in place. Fetched images, blobs, and responses cannot
be writable. Attach a writable image to only one running machine at a time.

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

Package names resolve from the public repository, and the builder downloads
them through the host network and verifies that the repository signed them.
Paths to local `.apk` files are trusted because you supplied them, so they are
installed without signature checks. Local packages install after the named
ones with no repository and no network, so their dependencies must be named or
local packages too. A build whose packages are all local files uses no network.

The output is written to a temporary file beside it and renamed into place
once the build succeeds, so a failed build leaves an existing file untouched.

Files and links are layered over the installed packages, as in the Nix
`mkImage`. A file mode is an octal string applied exactly, setuid, setgid, and
sticky bits included; without one an entry keeps its host mode and gains owner
write. A directory source onto an existing directory, such as `/etc` or
`/usr`, merges its contents into it; its mode, if given, applies to the
destination directory alone, and a merge otherwise keeps the existing
directory's mode. Entries apply in path order, so a file inside a directory
entry overrides what it copied.

The default format is EROFS, which the kernel mounts read-only. Pass
`format: "ext4"` for a writable image, with `size` setting its capacity. The
image has no label unless you pass `label`. Boot it with
`rootImage("app.erofs")`, or mount an ext4 image writable with
`{ path: "/", source: "app.ext4", type: "ext4" }`.

EROFS images are compressed with deflate by default, which typically makes
them 2 to 3 times smaller at a modest cost on reads. `compression: "lzma"` is
about 14% smaller again but reads about half as fast, and `compression:
"none"` stores data as is. ext4 images are never compressed.

The command-line equivalent is `npx lowland build`, provided by the `lowland`
package.

## License

The TypeScript and JavaScript sources are available under the MIT license. The
published images also contain GPL-2.0-only BusyBox and apk-tools, MIT-licensed
musl, and the MPL-2.0 Mozilla CA certificate bundle. The builder image also
contains GPL-2.0-only e2fsprogs and GPL-2.0-or-later erofs-utils.

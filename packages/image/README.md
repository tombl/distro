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
it needs no configuration in Node, browsers, or bundlers. Node reads the file
on demand. Browsers fetch it once and share it between machines.

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
nor an ext4 filesystem fails `bootMachine()` with an error that names it. This
catches a development server that answers a mistyped asset URL with an HTML
page.

## Writable images

Images are read-only by default. Pass `writable: true` to let the guest write
to an ext4 image:

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
be writable. Attach a writable image to only one running machine at a time.

The guest decides when its writes reach the image. Data is written once the
guest flushes it, for example by running `sync` or unmounting the filesystem,
so run `sync` in the guest before closing the machine to keep recent changes.

The guest agent mounts an ext4 root read-write. To boot a read-only ext4 image
as the root, pass the `lowland.root.overlay=tmpfs` kernel argument described in
the `@lowland/guest` README.

## Installing packages

The image trusts the signing key of the public repository at
`http://assets.low.land/apk/wasm32/Packages.adb` and resolves names through
`nameserver 192.0.2.1`, the host side of a `@lowland/guest` network. Attach a
network as described in the `@lowland/guest` README, then install packages
with apk:

```js
await guest.run(["apk", "add", "curl"]);
```

## License

The TypeScript and JavaScript sources are available under the MIT license. The
published image also contains GPL-2.0-only BusyBox and apk-tools, MIT-licensed
musl, and the MPL-2.0 Mozilla CA certificate bundle.

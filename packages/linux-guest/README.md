# `@tombl/linux-guest`

`@tombl/linux-guest` provides a bootable Linux guest for JavaScript, with APIs for processes, files, and networking.

## Installation

```sh
npm install @tombl/linux @tombl/linux-guest
```

## Usage

```js
import { blockDevice, spawnGuest } from "@tombl/linux-guest";

const rootfs = new Uint8Array(await fetch("/rootfs.squashfs").then((r) => r.arrayBuffer()));
const root = blockDevice({
  capacity: rootfs.byteLength,
  read: (offset, length) => rootfs.subarray(offset, offset + length),
});
const guest = await spawnGuest({ root });
const process = await guest.exec(["uname", "-a"]);

console.log(await new Response(process.stdout).text());
guest.machine.close();
```

## Share a host directory

`@tombl/linux-guest/node` adapts a host directory to virtio-fs:

```js
import { spawnGuest, fileSystemDevice } from "@tombl/linux-guest";
import { NodeFS } from "@tombl/linux-guest/node";

const shared = new NodeFS("/srv/guest-share");
const guest = await spawnGuest({
  root,
  devices: [
    fileSystemDevice(shared, {
      tag: "host",
      cache: false,
    }),
  ],
});

await guest.fs.mkdir("/workspace/host");
const mount = await guest.exec([
  "mount",
  "-t",
  "virtiofs",
  "host",
  "/workspace/host",
]);
if (!(await mount.status).success) throw new Error("mount failed");
```

Pass `{ readOnly: true }` to reject writable opens and every mutating backend
operation. This must be set on the backend even when the guest mount also uses
`-o ro` if read-only access is part of the trust boundary.

The Node adapter exposes symbolic links without following their final targets
on the host; the guest kernel resolves their targets inside the guest. It
validates every host path beneath the configured root and serializes guest
namespace operations so the guest cannot race its own validation.

Use an application-owned directory whose namespace is not concurrently
restructured by another host process. Portable Node does not expose the
descriptor-relative `openat2`/`*at` operations needed to make containment
race-free while an unrelated host process renames ancestors or introduces
symlinks. Under that kind of concurrent host mutation this adapter is not a
hard sandbox boundary. A deployment requiring that stronger guarantee needs
an OS sandbox or a native descriptor-relative filesystem helper.

In a browser, the adapter accepts any writable `FileSystemDirectoryHandle`.
Use OPFS for storage private to the site:

```js
import { spawnGuest, fileSystemDevice } from "@tombl/linux-guest";
import { BrowserFS } from "@tombl/linux-guest/browser";

const opfs = await navigator.storage.getDirectory();
const shared = new BrowserFS(
  await opfs.getDirectoryHandle("guest", { create: true }),
);
const guest = await spawnGuest({
  root,
  devices: [
    fileSystemDevice(shared, {
      tag: "persistent",
    }),
  ],
});
```

It also accepts a user-selected directory for interchange with local
applications:

```js
const shared = new BrowserFS(
  await window.showDirectoryPicker({ mode: "readwrite" }),
);
const device = fileSystemDevice(shared, {
  tag: "interchange",
  cache: false,
});
```

OPFS and selected directories expose the same browser File System API handles.
That API has no Unix modes, owners, links, or inode metadata, so the adapter
synthesizes conventional values; changes to that synthetic metadata last for
the lifetime of the adapter, while file and directory contents persist in the
underlying storage. The portable API has no atomic rename operation, so renames
copy to an empty destination and then remove the source. Renaming over an
existing destination is unsupported and leaves it untouched. Failure can leave
a partial newly-created destination, or both names if removing the source fails.

Browser handles also cannot keep an unlinked file alive like a Unix file
descriptor. When the adapter sees a path disappear, old guest descriptors for
that entry become stale and fail instead of targeting a replacement. The
portable API cannot detect an external remove-and-recreate if it never observes
the path missing. Writable operations from one adapter are serialized, but the
browser API cannot provide POSIX-equivalent coordination with other adapters,
tabs, or local applications. Closing a browser writable commits its transaction
but does not promise physical-media durability.

Devices cache names and attributes for one second and use the guest data page
cache. Use `cache: false` for interchange directories which other applications
modify; it sets metadata and name validity to zero, but it is not direct I/O and
does not disable the data page cache. Host writes are therefore not guaranteed
to become visible through an already-open guest descriptor.

## Runner directory shares

The standalone runner mounts host directories automatically. Both options can
be repeated and require an absolute guest path:

```sh
wasm-linux-runner \
  --share ./project:/workspace/project \
  --share-ro ./toolchain:/opt/toolchain
```

`--share` grants the guest read-write access. `--share-ro` combines a
read-only guest mount with backend enforcement, so raw guest filesystem calls
cannot make the host directory writable. Shares disable virtio-fs metadata and
name caching for host/guest interchange. Automatic mounting is provided by the
default runner image; a custom root disk must consume the `wasm.share=`
kernel parameters and mount the attached devices itself.

## Documentation

See [linux.tombl.dev](https://linux.tombl.dev/getting-started/).

## API

See the [`@tombl/linux-guest` reference](https://linux.tombl.dev/reference/linux-guest/).

## License

The TypeScript and JavaScript sources are available under the MIT license. The published installation also contains the Linux kernel (`GPL-2.0-only WITH Linux-syscall-note`), musl (MIT), and BusyBox (`GPL-2.0-only`).

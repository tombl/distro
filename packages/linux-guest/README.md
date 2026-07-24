# `@tombl/linux-guest`

`@tombl/linux-guest` provides a bootable Linux guest for JavaScript, with APIs for processes, files, and networking.

## Installation

```sh
npm install @tombl/linux @tombl/linux-guest
```

## Usage

```js
import { spawnGuest } from "@tombl/linux-guest";

const guest = await spawnGuest();
const process = await guest.exec(["uname", "-a"]);

console.log(await new Response(process.stdout).text());
guest.machine.close();
```

## Share a host directory

`@tombl/linux-guest/node` adapts a host directory to virtio-fs:

```js
import { spawnGuest, virtioFileSystemDevice } from "@tombl/linux-guest";
import { VirtioFileSystem } from "@tombl/linux-guest/node";

const shared = new VirtioFileSystem("/srv/guest-share");
const guest = await spawnGuest({
  devices: [
    virtioFileSystemDevice(shared, {
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

The Node adapter exposes symbolic links without following their final targets
on the host; the guest kernel resolves their targets inside the guest. It
validates every host path beneath the configured root. Node does not expose an
`openat2`-style API, so a separate host process which can mutate that root could
still race path validation.

In a browser, the adapter accepts any writable `FileSystemDirectoryHandle`.
Use OPFS for storage private to the site:

```js
import { spawnGuest, virtioFileSystemDevice } from "@tombl/linux-guest";
import { VirtioFileSystem } from "@tombl/linux-guest/browser";

const opfs = await navigator.storage.getDirectory();
const shared = new VirtioFileSystem(
  await opfs.getDirectoryHandle("guest", { create: true }),
);
const guest = await spawnGuest({
  devices: [
    virtioFileSystemDevice(shared, {
      tag: "persistent",
    }),
  ],
});
```

It also accepts a user-selected directory for interchange with local
applications:

```js
const shared = new VirtioFileSystem(
  await window.showDirectoryPicker({ mode: "readwrite" }),
);
const device = virtioFileSystemDevice(shared, {
  tag: "interchange",
  cache: false,
});
```

OPFS and selected directories expose the same browser File System API handles.
That API has no Unix modes, owners, links, or inode metadata, so the adapter
synthesizes conventional values; changes to that synthetic metadata last for
the lifetime of the adapter, while file and directory contents persist in the
underlying storage. The portable API has no atomic rename operation, so renames
use a copy-and-remove fallback.

Devices cache names and attributes for one second and use the guest page cache
by default. Use `cache: false` for interchange directories which other
applications modify; it disables metadata/name caching and uses direct I/O.
Writes to an open file become visible without cache revalidation, though
replacing a path does not retarget an already-open file descriptor.

## Documentation

See [linux.tombl.dev](https://linux.tombl.dev/getting-started/).

## API

See the [`@tombl/linux-guest` reference](https://linux.tombl.dev/reference/linux-guest/).

## License

The TypeScript and JavaScript sources are available under the MIT license. The published installation also contains the Linux kernel (`GPL-2.0-only WITH Linux-syscall-note`), musl (MIT), and BusyBox (`GPL-2.0-only`).

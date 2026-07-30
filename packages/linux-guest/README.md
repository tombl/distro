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
validates every host path beneath the configured root. Use an application-owned
or trusted directory: the Node adapter is not a sandbox against another host
process concurrently restructuring that directory, because Node does not expose
the descriptor-relative APIs needed to close that race.

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
copy to an empty destination and then remove the source. Renaming over an
existing destination is unsupported and leaves it untouched. Failure can leave
a partial newly-created destination, or both names if removing the source fails.

Browser handles also cannot keep an unlinked file alive like a Unix file
descriptor. When the adapter sees a path disappear, old guest descriptors for
that entry become stale and fail instead of targeting a replacement. The
portable API cannot detect an external remove-and-recreate if it never observes
the path missing.

Devices cache names and attributes for one second and use the guest data page
cache. Use `cache: false` for interchange directories which other applications
modify; it sets metadata and name validity to zero, but it is not direct I/O and
does not disable the data page cache. Host writes are therefore not guaranteed
to become visible through an already-open guest descriptor.

## Documentation

See [linux.tombl.dev](https://linux.tombl.dev/getting-started/).

## API

See the [`@tombl/linux-guest` reference](https://linux.tombl.dev/reference/linux-guest/).

## License

The TypeScript and JavaScript sources are available under the MIT license. The published installation also contains the Linux kernel (`GPL-2.0-only WITH Linux-syscall-note`), musl (MIT), and BusyBox (`GPL-2.0-only`).

# `@lowland/guest`

`@lowland/guest` is the Lowland guest-agent integration. It contributes its
private boot filesystem and vsock transport to an `@lowland/kernel` machine and
exposes processes, files, mounts, and networking through the returned agent.

## Installation

```sh
npm install @lowland/kernel @lowland/guest
```

## Usage

```js
import { blockDevice, bootMachine } from "@lowland/kernel";
import { guestAgent } from "@lowland/guest";

const rootfs = new Uint8Array(
  await fetch("/rootfs.erofs").then((response) => response.arrayBuffer()),
);
const root = blockDevice({
  capacity: rootfs.byteLength,
  read(offset, target) {
    const source = rootfs.subarray(offset, offset + target.byteLength);
    target.set(source);
    return source.byteLength;
  },
});

const guest = guestAgent();
await using machine = await bootMachine({
  cpus: 1,
  plugins: [root, guest],
});

const result = await guest.run(["uname", "-a"]);
console.log(new TextDecoder().decode(result.stdout));
```

`exec()` returns a live `ChildProcess` with streaming standard I/O. `run()`
collects its status, stdout, and stderr and is convenient for bounded commands.
Both methods accept an argv array without shell parsing.

The plugin boots its private EROFS using the GPT partition label
`LOWLAND_AGENT`, so its position among block-device plugins is irrelevant. The
agent then requires exactly one attached EROFS or ext4 filesystem labeled
`LOWLAND_ROOT`, pivots into it, and unmounts its private boot filesystem.
Missing and duplicate system roots fail `bootMachine()` through the plugin
readiness hook.

Pass `"lowland.root.overlay=tmpfs"` as a kernel argument to mount the system
image read-only beneath a temporary writable OverlayFS:

```js
const guest = guestAgent();
await using machine = await bootMachine({
  cpus: 1,
  args: ["lowland.root.overlay=tmpfs"],
  plugins: [guest, root],
});
```

## Networking

Networking is another composable guest integration:

```js
import { createNetwork } from "@lowland/guest";

const guest = guestAgent();
const network = createNetwork({ connectTcp, resolveDns });
const attachment = network.attach(guest);

await using machine = await bootMachine({
  cpus: 1,
  plugins: [root, guest, attachment],
});

console.log(attachment.address);
```

The attachment contributes the virtio NIC and configures it after the agent is
ready. Each agent supports one network attachment; attach multiple agents to
the same network to put them on one private IPv4 subnet.

## Host directory adapters

`@lowland/guest/node` provides `NodeFS`, and
`@lowland/guest/browser` provides `BrowserFS`. Adapt them with the kernel's
`fileSystemDevice()` and mount the resulting virtio-fs device through the
agent:

```js
import { fileSystemDevice } from "@lowland/kernel";
import { NodeFS } from "@lowland/guest/node";

const shared = fileSystemDevice(new NodeFS("/srv/guest-share"), {
  tag: "host",
  cache: false,
});
const guest = guestAgent();
await using machine = await bootMachine({
  cpus: 1,
  plugins: [root, guest, shared],
});
await guest.fs.mkdir("/tmp/host");
await guest.mount("host", "/tmp/host", { type: "virtiofs" });
```

Pass `{ readOnly: true }` to `NodeFS` when read-only access is part of the trust
boundary. A read-only guest mount alone does not prevent writes through raw
filesystem requests. The Node adapter confines paths beneath its configured
root and does not follow final symlinks, but portable Node lacks the
descriptor-relative operations needed to make that confinement race-free
against an unrelated host process restructuring the directory. Use an OS
sandbox or native helper when that stronger boundary is required.

`BrowserFS` accepts OPFS and user-selected `FileSystemDirectoryHandle` values.
The browser API has no Unix inode metadata or atomic portable rename, so the
adapter synthesizes metadata and implements rename as copy-then-remove. A
failed rename can leave a partial destination or both names. Use `cache: false`
for directories modified outside the guest; this disables metadata and name
caching, but not the guest's data page cache.

## License

The TypeScript and JavaScript sources are available under the MIT license. The
published agent image also contains GPL-2.0-only BusyBox and MIT-licensed musl.

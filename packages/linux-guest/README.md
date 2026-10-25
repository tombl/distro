# `@lowland/guest`

`@lowland/guest` runs programs and works with files inside a Linux machine booted by
`@lowland/kernel`.

## Installation

```sh
npm install @lowland/kernel @lowland/guest
```

## Usage

```js
import { readFile } from "node:fs/promises";
import { blockDevice, bootMachine } from "@lowland/kernel";
import { guestAgent } from "@lowland/guest";

const image = await readFile("rootfs.erofs");
const root = blockDevice({
  capacity: image.byteLength,
  read(offset, target) {
    const source = image.subarray(offset, offset + target.byteLength);
    target.set(source);
    return source.byteLength;
  },
});

const guest = guestAgent();
await using machine = await bootMachine({ cpus: 1, plugins: [root, guest] });

const result = await guest.run(["uname", "-a"]);
console.log(new TextDecoder().decode(result.stdout));
```

The machine needs a root filesystem: one EROFS or ext4 image labelled `LOWLAND_ROOT`.
The Build an image guide explains how to make one.

The same code runs in a browser, with the image fetched instead of read from disk. The page must
be served with the cross-origin isolation headers described in the
[tutorial](https://docs.low.land/getting-started/).

## Processes

`guest.run()` waits for a program to exit and collects its status and output. `guest.exec()`
returns the running process with streaming standard input and output. Both take an argv array
and do not go through a shell.

## Files

`guest.fs` reads and writes files inside the machine. Files written from JavaScript are
immediately visible to programs in the guest, and the reverse is also true.

The root filesystem is read-only. Pass `"lowland.root.overlay=tmpfs"` in `args` to put a
writable layer in memory on top of it.

## Networking

`createNetwork()` connects guests to each other and to the outside world through functions you
provide for TCP connections and DNS lookups:

```js
import { createNetwork } from "@lowland/guest";

const network = createNetwork({ connectTcp, resolveDns });
const guest = guestAgent();
await using machine = await bootMachine({
  cpus: 1,
  plugins: [root, guest, network.attach(guest)],
});
```

Guests attached to the same network share one private IPv4 subnet.

## Sharing host directories

`NodeFS` from `@lowland/guest/node` and `BrowserFS` from `@lowland/guest/browser` expose a host
directory to the guest, which mounts it with `guest.mount()`. Their
[reference](https://docs.low.land/reference/guest/) describes what each one can and cannot
protect against.

## Documentation

See [docs.low.land](https://docs.low.land) for guides and the
[API reference](https://docs.low.land/reference/guest/).

## License

The TypeScript and JavaScript sources are available under the MIT license. The published agent
image also contains GPL-2.0-only BusyBox and MIT-licensed musl.

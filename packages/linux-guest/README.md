# `@lowland/guest`

`@lowland/guest` runs programs and works with files inside a Linux machine booted by
`@lowland/kernel`.

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

The agent boots from an initramfs, then mounts its mount table, which is like fstab, and makes
the entry at `/` the root. `rootImage()` from `@lowland/image` is a small root with BusyBox and
apk, beneath a writable layer in memory.
[Your own software](https://docs.low.land/your-own-software/) explains how to make your own, which
`rootImage("app.erofs")` boots in the same way. Each entry is a path, a source, a type, a mode
(`"rw"`, `"ro"`, or `"overlay"`), and options:

```js
const guest = guestAgent({
  mounts: [
    rootImage(),
    { path: "/data", source: "data.ext4", type: "ext4" },
    { path: "/src", source: new NodeFS("./src"), mode: "ro" },
    { path: "/scratch", type: "tmpfs" },
  ],
  init: ["/sbin/my-service"],
});
```

A source is a disk, which becomes a block device, or a filesystem such as `NodeFS`, which
becomes a virtio-fs device. Without a type, the guest tries each filesystem it supports, as
BusyBox `mount` does. `init`, if given, starts once the root is mounted, and its exit powers the
machine off. A step that fails makes `bootMachine()` reject with a `GuestBootError` that names
the step, with the error as its `cause` and the end of the kernel's log as its `kernelLog`.
`boot` replaces the whole boot with your own calls.

The same code runs in a browser. The page must be served with the cross-origin isolation
headers described in [Hosting](https://docs.low.land/hosting/).

## Processes

`guest.run()` waits for a program to exit and collects its status and output. `guest.exec()`
returns the running process with streaming standard input and output. Both take an argv array
and do not go through a shell.

With the `terminal` option, `guest.exec()` runs the program on a guest pseudoterminal instead
of pipes, so an interactive shell gets job control and Ctrl-C written to `stdin` signals its
foreground job. Standard error shares `stdout`, and `resize()` changes the window size.

## Files

`guest.fs` reads and writes files inside the machine. Files written from JavaScript are
immediately visible to programs in the guest, and the reverse is also true.

The root filesystem is writable. Changes to a read-only image, such as the one from
`rootImage()`, are kept in memory and lost when the machine closes. Changes to an ext4 image
mounted writable, `{ path: "/", source: "app.ext4", type: "ext4" }`, are written back to it.

## Networking

`createNetwork()` connects guests to each other and to the outside world through functions you
provide for TCP connections and DNS lookups:

```js
import { createNetwork } from "@lowland/guest";

const network = createNetwork({ connectTcp, resolveDns });
const guest = guestAgent({ mounts: [rootImage()] });
await using machine = await bootMachine({
  cpus: 1,
  plugins: [guest, network.attach(guest)],
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

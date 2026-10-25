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

const guest = guestAgent();
await using machine = await bootMachine({ cpus: 1, plugins: [rootImage(), guest] });

const result = await guest.run(["uname", "-a"]);
console.log(new TextDecoder().decode(result.stdout));
```

The machine needs a root filesystem: one EROFS or ext4 image labelled `LOWLAND_ROOT`.
`rootImage()` from `@lowland/image` attaches a small one with BusyBox and apk.
[Build an image](https://docs.low.land/build-an-image/) explains how to make your own, and a
missing or duplicate root makes `bootMachine()` reject with a `GuestBootError`.

The same code runs in a browser. The page must be served with the cross-origin isolation
headers described in [Set up a browser page](https://docs.low.land/set-up-a-browser-page/).

## Processes

`guest.run()` waits for a program to exit and collects its status and output. `guest.exec()`
returns the running process with streaming standard input and output. Both take an argv array
and do not go through a shell.

## Files

`guest.fs` reads and writes files inside the machine. Files written from JavaScript are
immediately visible to programs in the guest, and the reverse is also true.

The root filesystem is writable. Changes to an EROFS image, such as the one from `rootImage()`,
are kept in memory and lost when the machine closes. Changes to an ext4 image are written back
to it.

## Networking

`createNetwork()` connects guests to each other and to the outside world through functions you
provide for TCP connections and DNS lookups:

```js
import { createNetwork } from "@lowland/guest";

const network = createNetwork({ connectTcp, resolveDns });
const guest = guestAgent();
await using machine = await bootMachine({
  cpus: 1,
  plugins: [rootImage(), guest, network.attach(guest)],
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

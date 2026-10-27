# lowland

Lowland runs the Linux kernel, ported to WebAssembly, inside a browser tab or a Node.js process.
You can embed it in your own app as a sandbox for Linux programs.

Try it at [low.land](https://low.land). Read the documentation at
[docs.low.land](https://docs.low.land).

## Package

[`lowland`](packages/lowland) is the one npm package. Its entry points are layers you can
use on their own:

| Entry point           | Description                                                  |
| --------------------- | ------------------------------------------------------------ |
| `lowland`             | `Linux`, a machine with the guest agent and an image.        |
| `lowland/machine`     | Boots a Linux machine and attaches devices to it.            |
| `lowland/guest`       | Runs programs and works with files inside a booted machine.  |
| `lowland/image`       | The canonical system image, and `lowland/image/build`.       |
| `lowland/node`        | `NodeFS`, a host directory for the guest.                    |
| `lowland/browser`     | `BrowserFS`, the origin private file system for the guest.   |

It also provides the `lowland` command line.

## Building from source

See [contributing.md](contributing.md).

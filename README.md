# lowland

Lowland runs the Linux kernel, ported to WebAssembly, inside a browser tab or a Node.js process.
You can embed it in your own app as a sandbox for Linux programs.

Try it at [low.land](https://low.land). Read the documentation at
[docs.low.land](https://docs.low.land).

## Packages

| Package                                       | Description                                                   |
| --------------------------------------------- | ------------------------------------------------------------- |
| [`@lowland/kernel`](packages/kernel)          | Boots a Linux machine and attaches devices to it.             |
| [`@lowland/guest`](packages/linux-guest)      | Runs programs and works with files inside a booted machine.   |

## Building from source

See [contributing.md](contributing.md).

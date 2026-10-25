<!-- SPDX-License-Identifier: MIT -->

# `@lowland/kernel`

`@lowland/kernel` boots a Linux kernel, compiled to WebAssembly, inside a browser tab or a
Node.js process.

## Installation

```sh
npm install @lowland/kernel
```

## Usage

Most programs use this package together with
[`@lowland/guest`](https://www.npmjs.com/package/@lowland/guest), which runs programs and works
with files inside the machine. Its README has a complete example.

`bootMachine()` starts a machine with a number of CPUs, kernel arguments, and the devices to
attach:

```js
import { bootMachine, entropyDevice } from "@lowland/kernel";

await using machine = await bootMachine({
  cpus: 2,
  args: ["quiet"],
  plugins: [entropyDevice()],
});
```

Devices cover block storage, consoles, shared filesystems, networking, and entropy. Each virtual
CPU runs in its own worker. In a browser, the page must be served with the cross-origin isolation
headers described in [Set up a browser page](https://docs.low.land/set-up-a-browser-page/).

## Documentation

See [docs.low.land](https://docs.low.land) for guides and the
[API reference](https://docs.low.land/reference/kernel/).

## License

The TypeScript and JavaScript sources are available under the MIT license. The published package
also contains `vmlinux.wasm`, which is available under `GPL-2.0-only WITH Linux-syscall-note`.

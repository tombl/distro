# `@lowland/image`

`@lowland/image` is the canonical Lowland system image. It contains BusyBox,
apk-tools, and CA certificates, and apk installs further packages from the
public Lowland repository.

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
await using machine = await bootMachine({
  cpus: 1,
  plugins: [rootImage(), guest],
});

const result = await guest.run(["uname", "-a"]);
console.log(new TextDecoder().decode(result.stdout));
```

`rootImage()` attaches the image as a read-only block device. The image is an
EROFS filesystem labeled `LOWLAND_ROOT`, which the guest agent finds and mounts
as the root filesystem. Changes to the root filesystem last only for the life
of the machine.

The image ships inside this package and is loaded relative to the module, so
it needs no configuration in Node, browsers, or bundlers. Node reads the file
on demand. Browsers fetch it once and share it between machines.

## Installing packages

The image trusts the signing key of the public repository at
`http://assets.low.land/apk/wasm32/Packages.adb` and resolves names through
`nameserver 192.0.2.1`, the host side of a `@lowland/guest` network. Attach a
network as described in the `@lowland/guest` README, then install packages
with apk:

```js
await guest.run(["apk", "add", "curl"]);
```

## License

The TypeScript and JavaScript sources are available under the MIT license. The
published image also contains GPL-2.0-only BusyBox and apk-tools, MIT-licensed
musl, and the MPL-2.0 Mozilla CA certificate bundle.

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

## Documentation

See [linux.tombl.dev](https://linux.tombl.dev/getting-started/).

## API

See the [`@tombl/linux-guest` reference](https://linux.tombl.dev/reference/linux-guest/).

## License

The TypeScript and JavaScript sources are available under the MIT license. The published installation also contains the Linux kernel (`GPL-2.0-only WITH Linux-syscall-note`), musl (MIT), and BusyBox (`GPL-2.0-only`).

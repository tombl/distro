# `lowland`

`lowland` runs Linux machines from the command line in Node, or from
JavaScript in Node and browsers.

```sh
npm install lowland
```

## Running commands

```sh
npx lowland run uname -a
npx lowland run -v ./src:/work -w /work sh -c 'ls -l'
npx lowland run --image app.erofs --disk data.ext4:/data --network nat my-app
```

`lowland run` boots a fresh machine, runs one command, and exits with the
command's status. With no command, it starts a shell. Standard input, output,
and error are connected directly.

When stdin is a terminal, the shell runs on a guest terminal of the same size,
with job control: Ctrl-C and Ctrl-Z reach its foreground job, and resizing the
window resizes the guest terminal. `-t`, `--tty` runs a given command on a
terminal too, such as `npx lowland run -t vi`. Otherwise commands run over
pipes, with stdout and stderr kept separate.

- `--image <path>` boots another root image, such as one from `lowland build`,
  instead of the canonical image. The root is always read-only beneath a
  temporary overlay, so running an image never changes it.
- `--disk <path:guest[:ro]>` attaches an EROFS or ext4 image file and mounts it.
  Writes to an ext4 disk persist in the file unless it is mounted `:ro`.
- `-v`, `--mount <host:guest[:ro]>` shares a host directory.
- `-w`, `--cwd <path>` sets the working directory, `/` by default.
- `-e`, `--env <name[=value]>` sets an environment variable, or passes one
  through from the host.
- `--cpus <count>` boots more virtual CPUs than the default of one.
- `--network nat` gives the guest egress through the host's sockets: its TCP
  connections and DNS lookups go out as lowland's own, and `192.0.2.1`
  reaches the host's loopback. The default, `--network none`, has no network.
- `-t`, `--tty` runs the command on a terminal. stdin must be a terminal.

## Exit status

`lowland` exits with one convention for every command:

| Status | Meaning |
| --- | --- |
| 0 | success |
| 125 | lowland itself failed, such as for an argument error, a failed build, or a machine that cannot run |
| 126 | `lowland run`: the command cannot be executed |
| 127 | `lowland run`: the command is not found |
| 128 + *n* | `lowland run`: signal *n* killed the command |
| anything else | `lowland run`: the command's own exit status |

## JavaScript

The same machines are available from JavaScript, in Node and in browsers:

```js
import { Linux } from "lowland";
import { rootImage } from "lowland/image";
import { NodeFS } from "lowland/node";

await using linux = await Linux.create({
  image: rootImage(),
  mounts: [{ source: new NodeFS("./src"), path: "/work" }],
});
const result = await linux.run(["ls", "/work"]);
console.log(new TextDecoder().decode(result.stdout));
```

`Linux.create()` takes the flags as objects rather than paths, so the same
code runs in a browser:

- `image` is required. `rootImage()` from `lowland/image` is the canonical
  image, with BusyBox, apk-tools, and CA certificates. Your own image, and
  each disk's `source`, take any source `rootImage()` accepts: a file path in
  Node, a URL, a file handle, bytes, a blob, or a response. The root is
  mounted read-only beneath a writable layer in memory, unless `image` is a
  mount entry of your own at `/`.
- `mounts` take a filesystem: a `NodeFS` from `lowland/node` for a host
  directory, or a `BrowserFS` from `lowland/browser` for the origin private
  file system.
- `network` takes a network from `createNetwork()` in `lowland/machine`, such
  as `createNetwork(nodeNetwork())` with `nodeNetwork` from `lowland/node` for
  the host's network, as `--network nat` uses.
- `cpus` and further `plugins` go to the machine.

`run()` collects a command's output, and `spawn()` streams it. Like
`lowland run`, both run commands in `/` unless their `cwd` option says
otherwise.

With the `terminal` option, a command runs on a guest terminal, as a shell
does in `lowland run`. In a page, connect it to a terminal emulator such as
xterm.js:

```js
const shell = await linux.spawn(["sh"], {
  terminal: { rows: term.rows, columns: term.cols },
});
void shell.stdout.pipeTo(new WritableStream({ write: (bytes) => term.write(bytes) }));
const keys = shell.stdin.getWriter();
term.onData((data) => void keys.write(new TextEncoder().encode(data)));
term.onResize(({ rows, cols }) => void shell.resize({ rows, columns: cols }));
```

In a browser, the page must be served with the cross-origin isolation headers
described in [Hosting](https://docs.low.land/hosting/).

## Entry points

`Linux` is built from layers that you can also use directly:

| Import | Contents |
| --- | --- |
| `lowland` | `Linux`, a machine with the guest agent and an image |
| `lowland/machine` | `bootMachine()`, virtio devices, networks, and the plugin API: the virtual hardware |
| `lowland/guest` | `guestAgent()`, processes, files, and mounts inside a machine |
| `lowland/image` | `rootImage()`, which attaches the canonical image or your own |
| `lowland/image/build` | `buildImage()`, which builds images in Node |
| `lowland/node` | `NodeFS`, a host directory for the guest, and `nodeNetwork()`, the host's network |
| `lowland/browser` | `BrowserFS`, the origin private file system for the guest |

```js
import { bootMachine } from "lowland/machine";
import { guestAgent } from "lowland/guest";
import { rootImage } from "lowland/image";

const guest = guestAgent({ mounts: [rootImage()] });
await using machine = await bootMachine({ cpus: 1, plugins: [guest] });
const result = await guest.run(["uname", "-a"]);
```

The guest agent boots from an initramfs, mounts its mount table, which is
like fstab, and makes the entry at `/` the root. Each entry is a path, a
source (a disk or a filesystem such as `NodeFS`), a type, a mode (`"rw"`,
`"ro"`, or `"overlay"`), and options.

Each entry point loads only the files it needs. The kernel, `vmlinux.wasm`,
comes with `lowland/machine` and what imports it, the guest agent's
initramfs, `agent.cpio`, with `lowland/guest`, and the canonical images with
`lowland/image`. An
application that boots its own image never bundles the canonical one.

These files load relative to their modules, so they need no configuration in
Node or browsers. Bundlers that emit `new URL(..., import.meta.url)` assets,
such as Vite 8, need no configuration either. The Vite 7 development server
moves prebundled dependencies into `node_modules/.vite/deps` without these
files, so exclude the package from dependency optimization there:

```js
// vite.config.js
export default {
  optimizeDeps: { exclude: ["lowland"] },
};
```

## Building images

```sh
npx lowland build --package busybox --package curl \
  --file ./build/app:/usr/local/bin/app:0755 \
  --output app.erofs
```

`lowland build` builds a system image from apk packages and host files. It
takes the same options as `buildImage()` from `lowland/image/build`, as
flags:

- `-p`, `--package <name|path>` installs a package by name, or from a local
  `.apk` file. Repeat it for each package.
- `-f`, `--file <host:guest[:mode]>` copies a host file or directory into the
  image, with an optional octal mode.
- `-l`, `--link <guest=target>` creates a symbolic link.
- `--format` is `erofs` (the default) or `ext4`.
- `--compression` is `deflate` (the default), `lzma`, or `none`, and applies
  to EROFS only.
- `--label` sets the filesystem label. There is none by default.
- `--size` sets the image size, such as `64M`. It defaults to `256M`.
- `-o`, `--output <file>` is the image file to write.

Run `npx lowland build --help` for a summary.

## Documentation

See [docs.low.land](https://docs.low.land) for guides and the
[API reference](https://docs.low.land/reference/lowland/).

## License

The TypeScript and JavaScript sources are available under the MIT license. The
package also contains:

- `vmlinux.wasm`, the Linux kernel, under `GPL-2.0-only WITH Linux-syscall-note`;
- the guest agent's initramfs, statically linked with MIT-licensed musl;
- the canonical and builder images, with GPL-2.0-only BusyBox and apk-tools,
  MIT-licensed musl, and the MPL-2.0 Mozilla CA certificate bundle. The
  builder image also contains GPL-2.0-only e2fsprogs and GPL-2.0-or-later
  erofs-utils.

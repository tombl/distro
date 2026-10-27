# `lowland`

`lowland` runs Linux machines from the command line in Node, or from
JavaScript in Node and browsers.

## Running commands

```sh
npx lowland run uname -a
npx lowland run -v ./src:/work -w /work sh -c 'ls -l'
npx lowland run --image app.erofs --disk data.ext4:/data --network host my-app
```

`lowland run` boots a fresh machine, runs one command, and exits with the
command's status. With no command, it starts a shell. Standard input, output,
and error are connected directly.

When stdin is a terminal, the shell runs on a guest terminal of the same size,
with job control: Ctrl-C and Ctrl-Z reach its foreground job, and resizing the
window resizes the guest terminal. `-t`, `--tty` runs a given command on a
terminal too, such as `npx lowland run -t vi`. Otherwise commands run over
pipes, with stdout and stderr kept separate.

- `--image <path>` boots another root image, such as one from `lowland build`.
  The root is always read-only beneath a temporary overlay, so running an
  image never changes it.
- `--disk <path:guest[:ro]>` attaches an EROFS or ext4 image file and mounts it.
  Writes to an ext4 disk persist in the file unless it is mounted `:ro`.
- `-v`, `--mount <host:guest[:ro]>` shares a host directory.
- `-w`, `--cwd <path>` sets the working directory, `/` by default.
- `-e`, `--env <name[=value]>` sets an environment variable, or passes one
  through from the host.
- `--cpus <count>` boots more virtual CPUs than the default of one.
- `--network host` connects the machine to the host's network: guest TCP
  connections and DNS lookups go out through the host, and `192.0.2.1`
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
import { NodeFS } from "@lowland/guest/node";

await using linux = await Linux.create({
  mounts: [{ source: new NodeFS("./src"), path: "/work" }],
});
const result = await linux.run(["ls", "/work"]);
console.log(new TextDecoder().decode(result.stdout));
```

`Linux.create()` takes the flags as objects rather than paths, so the same
code runs in a browser:

- `image` and each disk's `source` take any source `rootImage()` from
  `@lowland/image` accepts: a file path in Node, a URL, a file handle, bytes,
  a blob, or a response.
- `mounts` take a filesystem: a `NodeFS` for a host directory, or a
  `BrowserFS` from `@lowland/guest/browser` for the origin private file system.
- `network` takes a network from `createNetwork()` in `@lowland/guest`.
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

## Building images

```sh
npx lowland build --package busybox --package curl \
  --file ./build/app:/usr/local/bin/app:0755 \
  --output app.erofs
```

`lowland build` builds a system image from apk packages and host files. It
takes the same options as `buildImage()` from `@lowland/image/build`, as
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

## License

MIT

# JavaScript-first repository design

Status: accepted. Its four packages later became one, `lowland`, with an entry
point per layer (`lowland/machine`, `lowland/guest`, `lowland/image`). See
`packages/lowland/README.md`. The package sections below keep their original
names. The API sections describe the current API, in which a machine shuts
down, reboots or is killed rather than closed, and `lowland run` takes
volumes.

This document describes the intended package API, repository layout, artifact
boundary, and development workflow. It is deliberately a design document, not
an implementation compatibility plan: the new packages can replace the current
API without preserving its multiple machine constructors.

## Principles

- There is one machine concept and one function that boots it.
- pnpm owns JavaScript dependencies, builds, and test orchestration.
- Nix owns C and C-derived toolchains, the kernel, userspace programs,
  filesystem images, reproducible release builds, and CI applications.
- Package-relative `new URL()` assets remain the zero-configuration contract in
  Node, browsers, bundlers, and unbundled applications.
- Devices are the kernel's extension mechanism. Plugins are the small amount of
  composition needed when one logical integration contributes several devices,
  kernel arguments, or post-boot work.
- Canonical machines boot from block devices. The only initramfs Lowland ships
  is the guest agent's, and the kernel's initramfs ABI stays available for
  lower-level embeddings.
- The high-level product is easy by default, while each constituent part remains
  replaceable.

## Repository layout

```text
packages/                  JavaScript workspace
  bytes/                   @lowland/bytes (internal)
  kernel/                  @lowland/kernel
  guest/                   @lowland/guest
  image/                   @lowland/image
  lowland/                 lowland facade and CLI

apps/
  site/                    low.land browser application

distro/                    Nix package scope
  linux/                   kernel source pin and build
  guest-agent/             guest executable
  image/                   mkImage, the one image constructor
  site/                    site image, repository, and deployment
  toolchains/              LLVM, musl, Rust, and the wasm stdenv
  packages/                BusyBox and other wasm userspace packages
  tests/                   native assets used by Node tests
```

`packages/` should look and behave like an ordinary pnpm workspace. `apps/`
contains deployable applications rather than reusable packages. `distro/` is
not a second application framework: it supplies native artifacts to the
workspace and applications, and provides reproducible wrappers around both.

## Package factoring

### `@lowland/bytes`

This internal package contains the binary structure and byte-buffer helpers
used by the kernel and guest packages. Applications must not import it. Its
README states that it has no compatibility promise.

It remains a private workspace package. Each published package that uses it
lists it in `bundledDependencies`, so its release tarball contains a private
copy and no separate `@lowland/bytes` release or version coordination is
required.

### `@lowland/kernel`

This package owns the host side of the kernel boundary:

- the packaged `vmlinux.wasm`,
- WebAssembly memory and worker lifecycle,
- device-tree construction,
- virtio transports and devices,
- host filesystem adapters for Node and browsers,
- the machine plugin protocol, and
- the sole low-level boot function.

The TypeScript source currently published from the Linux checkout moves here.
The GPL kernel and other compiled sources remain in the Linux repository. This
repository materializes the resulting `vmlinux.wasm` as a regular ignored file
next to the JavaScript package before development or packaging. The library
continues to load it with `new URL("./vmlinux.wasm", import.meta.url)`, and callers
never pass a URL, byte array, or `WebAssembly.Module`.

### `@lowland/guest`

This package owns one optional integration: the Lowland guest agent.

- The host protocol client exposes the existing process, filesystem, syscall,
  and networking APIs.
- The package ships the agent as an initramfs asset: a newc archive holding only
  `/init`.
- `guestAgent()` returns the agent API and is also a machine plugin provider.
- It does not boot machines, re-export kernel devices, or ship BusyBox.

The agent executable is PID 1 on the initramfs. It mounts `devtmpfs` and serves
the host protocol, and the host drives the rest of the boot with ordinary calls.
The agent knows no filesystems.

### `@lowland/image`

This is the canonical, separately replaceable userspace image. Its userspace is
built from the Alpine-style APK package graph and includes BusyBox and apk-tools.
It contains a small JavaScript module, declarations, and package-relative image
assets. `rootImage()` returns the root entry of the guest agent's mount table,
beneath a temporary overlay.

The site derives its own image from the same package graph and the same
`mkImage` constructor, but is not required to ship the exact canonical image.
It adds site content such as its message of the day. The site or the `lowland`
facade, not the image package, selects the storage implementation.

Nix should expose a helper for producing another npm package with the same
shape from any `mkImage` result. An image is not intrinsically the kernel root
device: the same abstraction can be attached as any block device.

### `lowland`

This is the product facade and the package behind `npx lowland`. It combines the
canonical kernel, guest agent, image, entropy, and console integrations. It
owns ergonomic defaults and coordination, but it does not fork the underlying
guest API or introduce another machine implementation.

The JavaScript facade is stateful because a `Linux` value represents one live
Linux environment. The CLI is stateless: each `lowland run` is one-shot, and persistence exists
only where the caller explicitly supplies a persistent disk or mounted host
filesystem.

## Kernel API

The ordinary entry point remains small:

```ts
export interface BootMachineOptions {
  cpus: number;
  args?: readonly string[];
  plugins?: readonly MachinePluginInput[];
  reboot?: "restart" | "exit";
}

export interface Machine extends AsyncDisposable {
  readonly memory: WebAssembly.Memory;
  readonly exited: Promise<MachineExit>;
  shutdown(options?: PowerOptions): Promise<MachineExit>;
  reboot(options?: PowerOptions): Promise<void>;
  kill(): void;
}

export function bootMachine(options: BootMachineOptions): Promise<Machine>;
```

`cpus` is mandatory at the low-level boundary so callers make scheduling and
resource policy explicit. The `Linux` facade defaults to
one CPU as product policy, and applications such as the site choose explicitly.
Caller-supplied kernel arguments remain explicit top-level policy.
There is no `rootfs` or privileged `image` option. A disk is a device supplied
by a plugin like any other integration, and so is an initramfs: a plugin passes
newc archives to `setup.initramfs.add()`, the host concatenates them, and the
kernel pulls the result through its `boot.get_initrd` import.

The advanced plugin surface is part of `lowland/machine`:

```ts
export const machinePlugin: unique symbol;

export interface MachinePluginProvider {
  [machinePlugin](): MachinePlugin;
}

export type MachinePluginInput = MachinePlugin | MachinePluginProvider;

export interface MachinePlugin {
  configure(setup: MachineSetup): void | Promise<void>;
  booted?(machine: Machine): void | Promise<void>;
  power?(action: "poweroff" | "reboot"): boolean | Promise<boolean>;
}

export interface MachineSetup {
  readonly args: KernelArguments;
  readonly devices: MachineDevices;
  readonly initramfs: MachineInitramfs;
  readonly bootConsole: ReadableStream<Uint8Array>;
}
```

`bootMachine()` normalizes a provider by checking for `machinePlugin`, runs
each `configure()` callback against a private in-progress setup, boots once,
then awaits each `booted()` callback. `shutdown()` and `reboot()` ask each
`power()` hook, in reverse order, whether it started the action, and press the
kernel's power button if none did. The button runs `/sbin/poweroff` or
`/sbin/reboot` in the guest. A guest-agent provider can therefore add
its EROFS and vsock devices during configuration and make `bootMachine()`
resolve only once the agent answers. The setup value is not sealed or exposed
on the resulting machine. Plugin authors are responsible for not retaining and
misusing a configure-only value.

Simple devices can implement the plugin protocol themselves. A logical
integration can contribute multiple devices and kernel arguments.
The protocol does not mix capabilities into `Machine`: callers invoke guest
operations on the object returned by `guestAgent()`.

```ts
const agent = guestAgent({ mounts: [rootImage()] });

await using machine = await bootMachine({
  cpus: 1,
  plugins: [agent, entropyDevice(), consoleDevice(input, output)],
});

const result = await agent.run(["uname", "-a"]);
```

The block-storage primitive stays reusable. A range-request-backed disk should
be named for what it does, such as `fetchDisk()`, and live in a focused subpath.
It should not be called a root disk or coupled to the image package.

Every virtio device exposes a generic `closed` lifecycle promise. Integrations
that own resources alongside a device bind their cleanup to that promise, and the
transport must not grow device-specific hooks such as an Ethernet `onClose`.

## Initramfs boot contract

The guest agent ships as an initramfs that the kernel pulls from the host and
runs as `/init`. The kernel command line carries only what the kernel itself
consumes. The agent mounts `devtmpfs` and listens on vsock, and the host does
the rest with ordinary calls, as any initramfs would:

1. Mount `proc`, `sysfs`, and `devpts`.
2. Resolve each disk of the mount table by its virtio serial, `m<i>`, through
   `/sys/block/*/serial`. A shared filesystem's virtio-fs tag is `m<i>` too.
3. Mount the table beneath `/sysroot`, the root first. A missing type is tried
   from the non-`nodev` entries of `/proc/filesystems`. An overlay entry is a
   read-only lower layer with a tmpfs upper layer in the initramfs.
4. Move `/dev`, `/proc`, and `/sys` into `/sysroot`.
5. Delete the initramfs's files, then ask PID 1 to switch root. PID 1 enters
   `/sysroot` once the boot session has ended, so nothing that saw the old root
   survives, then starts the host's `init`, if any, and supervises it.

A mount table without `/` leaves the agent on its initramfs. `boot` replaces
the steps with the caller's own. Nothing is decided by filesystem type or
label: the storage's mode decides how the host opens it, and the kernel's own
read-only behaviour does the rest. An ext4 journal that needs recovery fails to
mount on read-only storage, and the error carries the kernel's log.

The canonical live site boots its EROFS image beneath an overlay. It also
attaches an unformatted persistent block device, which the installer formats
inside the guest. Once installed, the site boots that ext4 disk directly with a
boot of its own, because the disk lives in a worker. The agent is never copied
into the installed system.

EROFS is the canonical immutable-image format. SquashFS remains enabled in the
kernel for other embedders, but the canonical packages do not produce or ship
a SquashFS system image. Persistent storage is site or facade policy. The image
builder only constructs filesystems and does not decide how they are stored or
layered.

Linux retains its initramfs support and the host/kernel handoff ABI for custom
embeddings. The only initramfs the package ships is the guest agent's,
`agent.cpio`, which `lowland/guest` gives the kernel. The canonical images are
block devices.
Both handoffs, the device tree and the initramfs, use one size-query/copy
protocol: the kernel calls the import with no buffer to learn the size,
allocates the buffer itself, and calls it again to have the host copy into it.
The host never chooses an address in guest memory.

## High-level JavaScript API

`Linux` is a real class with a private constructor, because it owns a live
machine and coordinated integrations. Construction is asynchronous. It composes `bootMachine()` and `guestAgent()`
and adds nothing of its own beyond an entropy device.

```ts
export class Linux implements AsyncDisposable {
  private constructor(/* live components */);

  static create(options: LinuxOptions): Promise<Linux>;

  readonly machine: Machine;
  readonly guest: GuestAgent;
  readonly network: NetworkAttachment | undefined;
  readonly fs: FileSystem;
  readonly exited: Promise<MachineExit>;

  run(argv: readonly string[], options?: RunOptions): Promise<RunResult>;
  spawn(argv: readonly string[], options?: SpawnOptions): Promise<ChildProcess>;
  shutdown(options?: PowerOptions): Promise<MachineExit>;
  reboot(options?: PowerOptions): Promise<void>;
  kill(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface LinuxOptions {
  image: Mount | MountSource;
  mounts?: readonly Mount[];
  network?: Network;
  cpus?: number;
  init?: readonly string[];
  plugins?: readonly MachinePluginInput[];
}
```

`run()` is the foreground convenience operation and returns collected status
and output. `spawn()` returns a live process with streaming standard I/O. Both
take a complete argv array, and neither combines an `argv[0]` parameter with a
second arguments array. Both reuse the guest agent's `SpawnOptions`, `RunOptions`,
`RunResult`, and `ChildProcess` rather than defining parallel types. Their `terminal`
option runs a command on a guest pseudoterminal, as `lowland run` does for a
terminal, so a page can attach a shell to a terminal emulator such as xterm.js
and forward its resizes with `ChildProcess.resize()`.

The options are the `lowland run` flags in object form, but they take objects
rather than host paths, so `Linux` runs unchanged in Node and in browsers. Only
the CLI is Node-specific: it turns paths into these objects and checks them
before boot. `image` is required, so an application bundles the canonical
image only if it imports `lowland/image` for `rootImage()`. A bare source
means `{ path: "/", source, mode: "overlay" }`, so a `Linux` never writes to
its root image unless `image` is a mount entry that says so. `mounts` are the
rest of the guest agent's mount table: disks and virtio-fs backends, such as
`NodeFS` for a host directory or `BrowserFS` for the origin private file
system, each `rw`, `ro`, or beneath an overlay. `network` takes a network from
`createNetwork()`, which `Linux` attaches the machine to. Further plugins
follow the facade's own devices. Commands run in `/` unless their `cwd` says
otherwise. `linux.machine` and `linux.guest` are the composed layers, and the
lifecycle is the machine's. Disposing a `Linux` shuts the machine down, and
PID 1 ends every process, syncs and unmounts first, so writes reach their
sources. `kill()` stops it immediately.

## CLI shape

The `lowland` command has subcommands, so it can grow without overloading one
set of flags. There are two:

```text
Usage: lowland <command> [options]

Commands:
  run    Run a command in a fresh Linux machine
  build  Build a system image from apk packages and host files
```

`run` executes one command, or a shell when no command is given, in a fresh
machine:

```text
Usage: lowland run [options] [--] [command...]

Options:
  -v, --volume <src:dst[:rw|:ro|:O]>  Mount a host directory or image file (repeatable)
      --image <path>             Boot this root image instead of the canonical one
  -w, --workdir <dir>            Set the command working directory (default: /)
  -e, --env <name[=value]>       Set or pass through an environment variable (repeatable)
      --cpus <count>             Boot this many virtual CPUs (default: 1)
      --network <none|nat>       Give the machine a network (default: none)
  -t, --tty                      Run the command on a terminal; stdin must be one
```

The short flags follow `docker run`. A volume whose source is a directory is
shared, and a regular file is attached as a disk. `rw`, the default, writes
through, `ro` is read-only, and `O` puts a temporary overlay above the source.
A volume at `/` replaces the root, and `--image <path>` is `-v <path>:/:O`. `--network nat` gives the guest egress
through the host's sockets: its TCP connections and DNS lookups go out as
lowland's own, with the gateway address reaching the host's loopback. There is
no network by default.

`build` produces an image file that `run --image`, `rootImage(source)`, or any
block device can use. Its flags mirror `buildImage()` from `lowland/image/build`
one-to-one: `--package`, `--file host:guest[:mode]`, `--link guest=target`,
`--format`, `--label`, `--size`, `--compression`, and `--output`. The JavaScript
options object and these flags are the only build inputs. There is no build
file, no imperative build step, and no layer model: an image is declared as a
set of packages, files, and links, like `mkImage`.

Images are ordinary files named by path. There is no daemon, image store,
registry, tag, container name, or implicit state, so the CLI has no commands to
list, pull, push, or remove them. Each `run` boots one machine and shuts it down.
The root image is read-only beneath a tmpfs overlay by default, whether it is
EROFS or ext4, so running an image never changes it. Persistence exists only
where the caller asks for it, through a `rw` volume. There is no low-level
emulator switch in the product CLI. Kernel tests use the lower-level JavaScript
API rather than turning product flags into a second testing API.

`run` proxies the command's stdin, stdout, stderr, and exit status directly.
Every `lowland` command shares one exit status convention, `docker run`'s.
125 is lowland's own failure, including argument errors, a failed build, and a
machine that cannot run. `lowland run` reports 126 and 127 when the command
cannot be executed or is not found, 128 plus the signal number when a signal
kills it, and otherwise the command's own status.
Command mode uses ordinary pipes and preserves separate stdout and stderr.
With no command, `lowland run` starts `sh`. When stdin is a terminal, the
shell runs on a guest pseudoterminal of the host terminal's size, so it is
interactive and has job control. `-t` does the same for a given command, like
`docker run -it`, and fails when stdin is not a terminal. There is no `-i`:
standard input is always connected. On a terminal, lowland puts the host
terminal in raw mode until the command exits, restoring it even when lowland
fails or is signalled, so Ctrl-C, Ctrl-Z, and Ctrl-D go to the guest's line
discipline rather than to lowland. Host window size changes resize the guest
terminal, `TERM` defaults to `xterm`, and SIGINT, SIGTERM, and SIGHUP sent to
lowland go to the command. Standard error shares the terminal with standard
output, as it does on any terminal. When stdin is not a terminal, the shell runs over pipes.

`lowland/image` has no command of its own. The `lowland` command owns every
command-line entry point.

## Artifacts and development

There is one explicit bridge from Nix into the JavaScript workspace:

```text
pnpm artifacts
```

It builds and copies the native artifacts the packages ship as regular ignored
files to their owning packages: the kernel wasm and the guest-agent initramfs. It
does not create store symlinks, provenance sidecars, or an alternative
downloader. Test images are not artifacts: tests read them from
`$LOWLAND_TEST_ASSETS`, and build `.#test-assets` themselves when it is unset.

Normal iteration is then conventional:

```text
pnpm install
pnpm artifacts
pnpm test
pnpm build
```

Kernel iteration uses the already-supported lazy `fetchurl` override approach:
build a local Linux checkout with a Nix expression and copy its package output
into `packages/kernel/`. Other native dependencies use the same package-scope
override pattern. The contributing guide should contain concrete recipes for
JavaScript-only work, kernel worktrees, userspace packages such as BusyBox, and
toolchain work.

## Tests and CI

Node's test runner is the single test harness. Tests import and exercise the
published JavaScript surfaces and name their required native artifacts as
ordinary URLs. Early platform tests still boot a tiny test-specific EROFS image
and inspect console assertions without the guest agent, so a guest regression
cannot conceal a kernel or libc failure.

Nix builds individual test assets into one fixed layout, `.#test-assets`
(`distro/npm/test-assets.nix`), and `scripts/test-assets.ts` is the only code
that finds them. Each Nix check gets a link farm of just the assets it reads,
and runs the package's own `pnpm check` and `pnpm test` against the source
tree, Playwright suites included, rather than maintaining a parallel VM-test
protocol.

GitHub Actions remains split into jobs appropriate to caching and deployment,
but each YAML job delegates its behavior to a locally runnable Nix app, for
example `nix run .#check`, `nix run .#publish-npm`, or
`nix run .#publish-site`. The existing APK repository publication, production
deployment, pull-request previews, immutable asset URLs, and useful per-check
statuses remain product requirements. Shell tooling needed by those jobs is
packaged with `writeShellApplication` instead of being reimplemented inline in
YAML.

Networking is opt-in. `lowland/machine` documents separate recipes for native
TCP networking in Node, through `nodeNetwork()` from `lowland/node`, and
Fetch-backed HTTP networking in browsers. The facade does not silently select
either transport, and a network without adapters refuses outbound connections.

Release tarballs are assembled by Nix from pnpm-built JavaScript plus the exact
native artifacts, checked as ordinary npm packages, and published by the Nix
CI application.

## Migration sequence

1. Move the kernel host TypeScript into `packages/kernel`, materialize its wasm
   artifact, and remove the dangling workspace checkout dependency.
2. Introduce `bootMachine()` and the symbol-based plugin protocol, and adapt virtio
   devices as plugins without changing their device APIs.
3. Boot every canonical low-level test from a block device while retaining the
   kernel initramfs ABI for non-canonical embeddings.
4. Make the guest agent a PID-1 EROFS plugin and retain its capabilities on
   the agent object.
5. Define the image-to-`/root` association, publish the minimal image package
   shape, and add the Nix image-to-npm helper.
6. Build the `Linux` facade and the `lowland` CLI.
7. Make pnpm authoritative for JavaScript builds and Node tests, and add the single
   artifact materialization command.
8. Move native packages and tooling under `distro/`, move the browser app under
   `apps/site`, and retain its repository and deployment pipeline.
9. Replace CI shell with small job-specific Nix applications, then rewrite the
   contributor and architecture documentation against the finished workflow.
10. Publish the `lowland` package. The differently named historical npm
    packages can be archived independently and need not be deleted atomically.

Each step should leave one authoritative canonical path behind. The external
checkout link is deleted when the kernel host source moves. Initramfs remains a
supported low-level kernel capability, not a second canonical package workflow.

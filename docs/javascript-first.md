# JavaScript-first repository design

Status: accepted

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
  kernel arguments, device-tree entries, or post-boot work.
- Canonical machines boot from block devices. The kernel's initramfs ABI stays
  available for lower-level embeddings, but Lowland does not bundle or depend
  on an initramfs.
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
  images/                  filesystem construction and canonical image
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

- the packaged `vmlinux.wasm`;
- WebAssembly memory and worker lifecycle;
- device-tree construction;
- virtio transports and devices;
- host filesystem adapters for Node and browsers;
- the machine plugin protocol; and
- the sole low-level boot function.

The TypeScript source currently published from the Linux checkout moves here.
The GPL kernel and other compiled sources remain in the Linux repository. This
repository materializes the resulting `vmlinux.wasm` as a regular ignored file
next to the JavaScript package before development or packaging. The library
continues to load it with `new URL("./vmlinux.wasm", import.meta.url)`; callers
never pass a URL, byte array, or `WebAssembly.Module`.

### `@lowland/guest`

This package owns one optional integration: the Lowland guest agent.

- The host protocol client exposes the existing process, filesystem, syscall,
  and networking APIs.
- The package ships the agent boot disk as a squashfs asset.
- `guestAgent()` returns the agent API and is also a machine plugin provider.
- It does not boot machines, re-export kernel devices, or ship BusyBox.

The agent executable is PID 1 on its squashfs. It mounts `devtmpfs`, `devpts`,
`proc`, `sysfs`, and writable temporary filesystems itself, then serves the
host protocol. This makes it a small bootloader and control plane without an
additional CPIO archive or second copy of libc.

### `@lowland/image`

This is the canonical, separately replaceable userspace image. Its userspace is
built from the Alpine-style APK package graph and includes BusyBox and apk-tools.
It contains a small JavaScript module, declarations, and package-relative image
assets. It is a machine plugin provider. It attaches the image but does not
choose whether the machine is temporary or persistent.

The site derives its own image from the same package graph but is not required
to ship the exact canonical image. It adds site content such as its message of
the day. The site or the `lowland` facade, not the image package, selects the
storage implementation.

Nix should expose a helper for producing another npm package with the same
shape from any root filesystem derivation. An image is not intrinsically the
kernel root device: the same abstraction can be attached as any block device.

### `lowland`

This is the product facade and the package behind `npx lowland`. It combines the
canonical kernel, guest agent, image, entropy, and console integrations. It
owns ergonomic defaults and coordination, but it does not fork the underlying
guest API or introduce another machine implementation.

The JavaScript facade is stateful because a `Linux` value represents one live
Linux environment. The CLI is intentionally one-shot and stateless; persistence
exists only where the caller explicitly supplies a persistent disk or mounted
host filesystem.

## Kernel API

The ordinary entry point remains small:

```ts
export interface BootMachineOptions {
  cpus: number;
  args?: readonly string[];
  plugins?: readonly MachinePluginInput[];
  /** Low-level custom-embedding support; canonical packages boot from disks. */
  initcpio?: ArrayBufferView | PromiseLike<ArrayBufferView>;
}

export interface Machine extends AsyncDisposable {
  readonly memory: WebAssembly.Memory;
  readonly bootConsole: ReadableStream<Uint8Array>;
  readonly closed: Promise<void>;
  close(): void;
}

export function bootMachine(options: BootMachineOptions): Promise<Machine>;
```

`cpus` is mandatory at the low-level boundary so callers make scheduling and
resource policy explicit. The zero-argument `Linux.create()` facade may choose
one CPU as product policy; applications such as the site choose explicitly.
Caller-supplied kernel arguments remain explicit top-level policy.
There is no `rootfs` or privileged `image` option. `initcpio` preserves the
kernel's low-level initramfs handoff for custom embeddings and focused kernel
tests, but canonical packages do not use it. A disk is a device supplied by a
plugin like any other integration.

The advanced plugin surface can live at `@lowland/kernel/plugin`:

```ts
export const getMachinePlugin: unique symbol;

export interface MachinePluginProvider {
  [getMachinePlugin](): MachinePlugin;
}

export type MachinePluginInput = MachinePlugin | MachinePluginProvider;

export interface MachinePlugin {
  configure(setup: MachineSetup): void | Promise<void>;
  booted?(machine: Machine): void | Promise<void>;
}

export interface MachineSetup {
  readonly args: KernelArguments;
  readonly devices: MachineDevices;
  readonly deviceTree: DeviceTreeBuilder;
}
```

`bootMachine()` normalizes a provider by checking for `getMachinePlugin`, runs
each `configure()` callback against a private in-progress setup, boots once,
then awaits each `booted()` callback. A guest-agent provider can therefore add
its squashfs and vsock devices during configuration and make `bootMachine()`
resolve only once the agent answers. The setup value is not sealed or exposed
on the resulting machine; plugin authors are responsible for not retaining and
misusing a configure-only value.

Simple devices can implement the plugin protocol themselves. A logical
integration can contribute multiple devices, arguments, or device-tree changes.
The protocol does not mix capabilities into `Machine`: callers invoke guest
operations on the object returned by `guestAgent()`.

```ts
const agent = guestAgent();

await using machine = await bootMachine({
  cpus: 1,
  plugins: [agent, image, entropyDevice(), consoleDevice(terminal)],
});

const result = await agent.run(["uname", "-a"]);
```

The block-storage primitive stays reusable. A range-request-backed disk should
be named for what it does, such as `fetchDisk()`, and live in a focused subpath;
it should not be called a root disk or coupled to the image package.

Every virtio device exposes a generic `closed` lifecycle promise. Integrations
that own resources alongside a device bind their cleanup to that promise; the
transport must not grow device-specific hooks such as an Ethernet `onClose`.

## Block-root boot contract

The canonical host path does not supply an initramfs. The kernel first boots a
small agent filesystem:

```text
root=/dev/vda rootfstype=squashfs ro rootwait init=/init
```

The agent runs as PID 1. It mounts `devtmpfs`, `devpts`, `proc`, and `sysfs`.
It then finds the system image and mounts it. It moves the required virtual
filesystems into the new root and calls `pivot_root`. It then unmounts the agent
filesystem. Programs in the system cannot browse the agent files. The running
agent can remain visible through normal process information in `/proc`.

The agent finds the system image by label. It does not use the virtio device
order, a kernel argument, or information returned by `devices.add()`.

The image builder applies the label `LOWLAND_ROOT` as follows:

- For ext4, it sets the filesystem label with `mke2fs -L LOWLAND_ROOT`.
- SquashFS has no filesystem-label field. A SquashFS image therefore sits in a
  GPT partition whose partition name is `LOWLAND_ROOT`.

The image-construction API must document both forms. The agent accepts either
the ext4 filesystem label or the GPT partition name.

The first implementation boots the published image read-only. It does not add
persistent-storage behavior to the image plugin. A later persistence change
can place a temporary or persistent writable filesystem over the read-only
image. The site and the `lowland` facade select that writable storage. This
keeps the image package independent of the persistence implementation.

Linux retains its initramfs support and the host/kernel handoff ABI for custom
embeddings. The canonical packages do not materialize or bundle an initramfs.
The fixed-capacity handoff should eventually become a size-query/copy protocol;
that kernel improvement is independent of the package migration.

## High-level JavaScript API

`Linux` is a real class with a private constructor, because it owns a live
machine and coordinated integrations. Construction is asynchronous and
zero-argument creation is the primary path.

```ts
export class Linux implements AsyncDisposable {
  private constructor(/* live components */);

  static create(options?: LinuxOptions): Promise<Linux>;

  readonly fs: GuestFileSystem;

  run(args: readonly string[], options?: RunOptions): Promise<RunResult>;
  spawn(args: readonly string[], options?: SpawnOptions): Promise<Process>;
  close(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface LinuxOptions {
  plugins?: readonly MachinePluginInput[];
}
```

`run()` is the foreground convenience operation and returns collected status
and output. `spawn()` returns a live process with streaming standard I/O. Both
take a complete argv array; neither combines an `argv[0]` parameter with a
second arguments array. The facade forwards extra plugins but does not expose
a special image option.

## CLI shape

```text
Usage: lowland [options] [--] [command...]

Run a command in a fresh Linux machine. With no command, start a shell.

Options:
  --mount <host:guest>  Mount a host directory into the machine (repeatable)
  --disk <path>         Attach a persistent block device (repeatable)
  --cwd <path>          Set the command working directory
  --env <name=value>    Set an environment variable (repeatable)
  -h, --help            Show help
  -v, --version         Show the version
```

The command's stdin, stdout, stderr, and exit status are proxied directly. Each
invocation creates and closes one machine. There is no daemon, instance name,
implicit state, or low-level emulator switch in the product CLI. Kernel tests
use the lower-level JavaScript API rather than turning product flags into a
second testing API.

Command mode uses ordinary pipes and preserves separate stdout and stderr.
No-command interactive shell mode uses a guest PTY so terminal signals, job
control, and resize events have real terminal semantics.

## Artifacts and development

There is one explicit bridge from Nix into the JavaScript workspace:

```text
pnpm artifacts
```

It builds and copies all required native artifacts as regular ignored files to
their owning packages: the kernel wasm, guest-agent squashfs, canonical image,
and test images. It does not create store symlinks, provenance sidecars, or an
alternative downloader. JavaScript commands fail early with this exact remedy
when an artifact is absent.

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
ordinary URLs. Early platform tests still boot a tiny test-specific squashfs
and inspect console assertions without the guest agent, so a guest regression
cannot conceal a kernel or libc failure.

Nix builds individual test assets and aggregates them into one link farm for
`pnpm artifacts`; the simple command may materialize all assets. Nix checks run
the same Node suites in reproducible environments rather than maintaining a
parallel VM-test protocol.

GitHub Actions remains split into jobs appropriate to caching and deployment,
but each YAML job delegates its behavior to a locally runnable Nix app, for
example `nix run .#check`, `nix run .#publish-npm`, or
`nix run .#publish-site`. The existing APK repository publication, production
deployment, pull-request previews, immutable asset URLs, and useful per-check
statuses remain product requirements. Shell tooling needed by those jobs is
packaged with `writeShellApplication` instead of being reimplemented inline in
YAML.

Networking is opt-in. `@lowland/guest` documents separate recipes for native
TCP networking in Node and Fetch-backed HTTP networking in browsers; the
zero-argument facade does not silently select either transport.

Release tarballs are assembled by Nix from pnpm-built JavaScript plus the exact
native artifacts, checked as ordinary npm packages, and published by the Nix
CI application.

## Migration sequence

1. Move the kernel host TypeScript into `packages/kernel`, materialize its wasm
   artifact, and remove the dangling workspace checkout dependency.
2. Introduce `bootMachine()` and the symbol-based plugin protocol; adapt virtio
   devices as plugins without changing their device APIs.
3. Boot every canonical low-level test from a block device while retaining the
   kernel initramfs ABI for non-canonical embeddings.
4. Make the guest agent a PID-1 squashfs plugin and retain its capabilities on
   the agent object.
5. Define the image-to-`/root` association, publish the minimal image package
   shape, and add the Nix image-to-npm helper.
6. Build the `Linux` facade and one-shot `lowland` CLI.
7. Make pnpm authoritative for JavaScript builds and Node tests; add the single
   artifact materialization command.
8. Move native packages and tooling under `distro/`, move the browser app under
   `apps/site`, and retain its repository and deployment pipeline.
9. Replace CI shell with small job-specific Nix applications, then rewrite the
   contributor and architecture documentation against the finished workflow.
10. Publish the new `@lowland/*` packages. The differently named historical npm
    packages can be archived independently and need not be deleted atomically.

Each step should leave one authoritative canonical path behind. The external
checkout link is deleted when the kernel host source moves. Initramfs remains a
supported low-level kernel capability, not a second canonical package workflow.

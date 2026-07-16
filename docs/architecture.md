# Architecture

This repository builds the userspace and opinionated SDK for WebAssembly Linux. It depends on the kernel host package, but owns the integration boundary: a kernel is only useful once it can boot a real root filesystem and run real programs.

## Package boundary

`@tombl/linux`, published from the Linux repository, owns the raw kernel-to-JavaScript ABI, Web Worker lifecycle, virtio transport, and core devices. It remains useful without this distro and exposes devices as the extension point.

The SDK published from this repository owns the guest agent and its host client, the supported root filesystem contract, and the opinionated API for running commands and moving data across the guest boundary. The CLI and demo site are consumers of this SDK, not alternative integration layers.

## Userspace

Target packages are built for `wasm32-unknown-linux-musl`; host packages build the toolchain, images, SDK, tests, and applications which embed the machine. The package set should make this distinction explicit without leaking cross-compilation mechanics into each package.

`mkRootfs` constructs a conventional FHS tree by unioning the selected packages, files, and init program; conflicting non-identical paths are errors. It can encode that tree as writable ext4 or read-only squashfs. The SDK uses squashfs for immutable system files and mounts tmpfs at `/run`, `/tmp`, and `/workspace`; the standalone runner retains a persistent ext4 root.

WebAssembly Linux has no `fork()`, `vfork()`, or `mmap()` family. Programs spawn children through an explicit `clone()` entry point followed by `execve()`, normally exposed as `posix_spawn()`. Ports should replace private allocation or file-reading uses of `mmap()` with the operation they require rather than provide an incomplete mmap emulation.

## Testing

The distro owns integration tests because kernel smoke tests require the same libc, init, filesystem, and programs that users run.

Early tests boot a test-specific root filesystem whose minimal init performs one assertion and emits a single pass marker. A small Node runner starts the machine and fails on timeout, exception, kernel panic, explicit failure, or missing pass marker. This layer deliberately does not depend on the guest agent.

Consumer tests boot the production root filesystem and exercise the packaged SDK and guest agent through `node:test` or `Deno.test`. They test the same command, file, device, and lifecycle APIs that applications use. The early boot oracle remains below them so a broken agent cannot hide whether the kernel booted at all.

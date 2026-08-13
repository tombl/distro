# Architecture

This repository builds the userspace and opinionated SDK for WebAssembly Linux. It depends on the kernel host package, but owns the integration boundary: a kernel is only useful once it can boot a real root filesystem and run real programs.

## Package boundary

`@lowland/kernel`, published from this repository, owns the raw kernel-to-JavaScript ABI, Web Worker lifecycle, virtio transport, and core devices. The compiled kernel remains sourced from the Linux repository. The package remains useful without this distro and exposes devices as the extension point.

The guest package owns the guest agent and its host client, the supported root filesystem contract, and the APIs for running commands and moving data across the guest boundary. `guestAgent()` is a kernel plugin provider rather than another machine constructor: it contributes the GPT-wrapped agent EROFS, vsock transport, boot arguments, and readiness hook while retaining the bound guest capabilities on the returned object. The GPT partition label makes the agent disk independent of virtio device ordering using the kernel's standard `PARTLABEL` root lookup. Applications compose it with ordinary kernel plugins and call the kernel's sole `bootMachine()` function.

## Userspace

Target packages are built for `wasm32-unknown-linux-musl`; host packages build the toolchain, images, SDK, tests, and applications which embed the machine. The package set should make this distinction explicit without leaking cross-compilation mechanics into each package.

The wasm stdenv keeps the usual single-output derivations; Nix remains the build language and dependency solver for the build itself. It compiles FHS paths into target packages, stages installation under each Nix output, and strips wasm debug data during fixup. Packages become runtime artifacts at the repository boundary: `apk.mkPackage` turns an ordinary derivation into a native v3 binary APK (metadata is optional and lives on the derivation's `passthru.apk`), but does not rewrite its payload. Instead, packaging fails on every remaining Nix store reference so the producing package or standard environment must be corrected. `apk.mkRepository` indexes those artifacts, and `apk.mkSystem` asks host apk to solve and install a package selection into a conventional FHS tree with a real package database. The published repository is the runtime contract: the same index a booted guest installs from, and the same solver that built the images, so build-time and runtime installs cannot diverge. Product configuration is layered onto `mkSystem` results as `files` and `links`, and `image.mkFilesystem` only encodes that installed tree. It produces an immutable labeled EROFS image by default; `format = "ext4"` remains available for the later persistent installation path. Product disks remain owned by their consumers as `site.rootfs` and `runner.rootfs`, and are booted directly as block devices without a shared initramfs bundle. The guest SDK accepts a block device from its caller and does not publish a system root filesystem of its own.

WebAssembly Linux has no `fork()`, `vfork()`, or `mmap()` family. Programs spawn children through an explicit `clone()` entry point followed by `execve()`, normally exposed as `posix_spawn()`. Ports should replace private allocation or file-reading uses of `mmap()` with the operation they require rather than provide an incomplete mmap emulation.

## Networking

`@lowland/kernel` provides a virtio-net NIC and a small learning Ethernet switch.
The switch is the primitive: NICs attached to the same switch exchange ordinary
Ethernet frames without involving the guest agent or host TCP/IP endpoint.

`@lowland/guest` builds an opinionated IPv4 network on that primitive.
`network.attach(agent)` returns a plugin which attaches a NIC, assigns a static
address in `192.0.2.0/24`, and configures the kernel's address and default route
after the agent becomes ready. Its JavaScript endpoint
implements ARP, IPv4, TCP, UDP, and DNS. TCP connections to addresses outside
the virtual subnet are proxied through the caller's `connectTcp` adapter, which
can be implemented with Node's `net.connect`. The gateway address maps to the
host's loopback address. UDP proxying to arbitrary hosts is intentionally not
part of the first cut.

Each attachment exposes its assigned address and host connection API. Calling
`attach()` on the same `createNetwork()` result for multiple agents joins their
NICs to one switch. Omitting a network attachment starts the machine without a
NIC; network creation and ownership remain with the caller.

## Testing

The distro owns integration tests because kernel smoke tests require the same libc, init, filesystem, and programs that users run.

Every guest test boots an APK-installed system disk. A single generic boot initramfs mounts that disk and hands control to its installed `/init`; test programs and support tools arrive through APKs, so even early kernel/libc and browser stress tests exercise package construction and ownership. A small Node runner fails on timeout, exception, kernel panic, explicit failure, or a missing pass marker. The package-manager checks additionally install conflicting userland packages by name from an embedded index, proving dependency and replacement metadata through the target apk implementation.

Consumer tests boot the production root filesystem and exercise the packaged SDK and guest agent through `node:test`. They test the same command, file, device, and lifecycle APIs that applications use. The early boot oracle remains below them so a broken agent cannot hide whether the kernel booted at all.

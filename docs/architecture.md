# Architecture

This repository builds the userspace and opinionated SDK for WebAssembly Linux. It depends on the kernel host package, but owns the integration boundary: a kernel is only useful once it can boot a real root filesystem and run real programs.

## Package boundary

`@tombl/linux`, published from the Linux repository, owns the raw kernel-to-JavaScript ABI, Web Worker lifecycle, virtio transport, and core devices. It remains useful without this distro and exposes devices as the extension point.

The SDK published from this repository owns the guest agent and its host client, the supported root filesystem contract, and the opinionated API for running commands and moving data across the guest boundary. The CLI and demo site are consumers of this SDK, not alternative integration layers.

## Userspace

Target packages are built for `wasm32-unknown-linux-musl`; host packages build the toolchain, images, SDK, tests, and applications which embed the machine. The package set should make this distinction explicit without leaking cross-compilation mechanics into each package.

`image.mkRootfs` constructs a conventional FHS tree by copying the selected package fragments in list order, with each later entry shadowing an earlier entry at the same path, then adding explicit files and the init program. Every root filesystem is an immutable squashfs image, with writable tmpfs mounts at `/run`, `/tmp`, and `/workspace`. The default guest profile stays minimal, the site profile adds a curated interactive userland, and the standalone runner profile carries the full ported software set. Product artifacts are owned by their consumer: `linux-guest.image`, `site.image`, and `runner.image` each contain their shared boot initramfs and product-specific rootfs.

WebAssembly Linux has no `fork()`, `vfork()`, or `mmap()` family. Programs spawn children through an explicit `clone()` entry point followed by `execve()`, normally exposed as `posix_spawn()`. Ports should replace private allocation or file-reading uses of `mmap()` with the operation they require rather than provide an incomplete mmap emulation.

## Networking

`@tombl/linux` provides a virtio-net NIC and a small learning Ethernet switch.
The switch is the primitive: NICs attached to the same switch exchange ordinary
Ethernet frames without involving the guest agent or host TCP/IP endpoint.

`@tombl/linux-guest` builds an opinionated IPv4 network on that primitive.
`spawnGuest()` attaches a NIC, assigns a static address in `192.0.2.0/24`, and
configures the kernel's address and default route. Its JavaScript endpoint
implements ARP, IPv4, TCP, UDP, and DNS. TCP connections to addresses outside
the virtual subnet are proxied through the caller's `connectTcp` adapter, which
can be implemented with Node's `net.connect`. The gateway address maps to the
host's loopback address. UDP proxying to arbitrary hosts is intentionally not
part of the first cut.

Each guest exposes its assigned address and host connection API as
`guest.network`. Supplying the same `createNetwork()` result to multiple
`spawnGuest()` calls joins their NICs to one switch. Omitting `network` starts
the guest without a NIC; network creation and ownership remain with the caller.

## Testing

The distro owns integration tests because kernel smoke tests require the same libc, init, filesystem, and programs that users run.

Early tests boot a test-specific root filesystem whose minimal init performs one assertion and emits a single pass marker. A small Node runner starts the machine and fails on timeout, exception, kernel panic, explicit failure, or missing pass marker. This layer deliberately does not depend on the guest agent.

Consumer tests boot the production root filesystem and exercise the packaged SDK and guest agent through `node:test`. They test the same command, file, device, and lifecycle APIs that applications use. The early boot oracle remains below them so a broken agent cannot hide whether the kernel booted at all.

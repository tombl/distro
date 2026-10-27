# Architecture

This repository builds the userspace and opinionated SDK for WebAssembly Linux. It depends on the kernel host package, but owns the integration boundary: a kernel is only useful once it can boot a real root filesystem and run real programs.

## Package boundary

`lowland/machine`, the machine layer of the `lowland` package published from this repository, owns the raw kernel-to-JavaScript ABI, Web Worker lifecycle, virtio transport, and core devices. The compiled kernel remains sourced from the Linux repository. The layer remains useful without this distro and exposes devices as the extension point.

The guest layer, `lowland/guest`, owns the guest agent and its host client, the supported root filesystem contract, and the APIs for running commands and moving data across the guest boundary. `guestAgent()` is a kernel plugin provider rather than another machine constructor: it contributes the agent as an initramfs, its vsock transport, a device for each source in its mount table, and the hook that boots the guest, while retaining the bound guest capabilities on the returned object. Mount table disks carry virtio serials, so the boot is independent of virtio device ordering. Applications compose it with ordinary kernel plugins and call the kernel's sole `bootMachine()` function.

## Userspace

Target packages are built for `wasm32-unknown-linux-musl`; host packages build the toolchain, images, SDK, tests, and applications which embed the machine. The package set should make this distinction explicit without leaking cross-compilation mechanics into each package.

The wasm stdenv keeps the usual single-output derivations; Nix remains the build language and dependency solver for the build itself. It compiles FHS paths into target packages, stages installation under each Nix output, and strips wasm debug data during fixup. Packages become runtime artifacts at the repository boundary: each derivation is converted into a native v3 binary APK (metadata is optional and lives on the derivation's `passthru.apk`) without rewriting its payload. Instead, packaging fails on every remaining Nix store reference so the producing package or standard environment must be corrected. The published `repository` indexes those artifacts for booted guests. Images have one constructor, `mkImage`: it takes derivations, resolves their declared `passthru.apk.depends` by name against the package scope, and asks host apk to install that closure into a conventional FHS tree with a real package database, so build-time and runtime installs use the same packages and solver. Product configuration is layered on top as `files` and `links`, and the tree is encoded as an immutable labeled EROFS image by default; `format = "ext4"` remains available for the later persistent installation path. The APK, repository, and encoding steps behind it are private to the scope. Product disks remain owned by their consumers as `site.rootfs` and `runner.rootfs`, and are booted directly as block devices without a shared initramfs bundle. The guest SDK accepts a block device from its caller and does not publish a system root filesystem of its own.

WebAssembly Linux has no `fork()`, `vfork()`, or `mmap()` family. Programs spawn children through an explicit `clone()` entry point followed by `execve()`, normally exposed as `posix_spawn()`. Ports should replace private allocation or file-reading uses of `mmap()` with the operation they require rather than provide an incomplete mmap emulation.

C++ exceptions and `setjmp`/`longjmp` both use WebAssembly exception handling in its legacy encoding (`try`/`catch`/`delegate`), not the standardized exnref one (`try_table`). Every engine we test runs both: Node 24 and current Chromium, Firefox and WebKit. Legacy also runs on older engines that predate exnref (Safari before 18.4, Chrome before 137, Firefox before 131), is what LLVM 22 emits by default, and is what `setjmp` already compiled to before C++ exceptions were enabled. exnref buys nothing functional here. Revisit when LLVM changes its default or an engine we support drops the legacy encoding; switching means rebuilding the whole package set, because libc++abi, libunwind and every `setjmp` call site carry the encoding. Guest handlers, including `catch (...)` and the cleanups that run destructors, cannot intercept the kernel ending a process image on `exit()` or `execve()`, because those halts are traps.

## Networking

`lowland/machine` provides a virtio-net NIC and a small learning Ethernet switch.
The switch is the primitive: NICs attached to the same switch exchange ordinary
Ethernet frames without involving the guest agent or host TCP/IP endpoint.

`lowland/guest` builds an opinionated IPv4 network on that primitive.
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

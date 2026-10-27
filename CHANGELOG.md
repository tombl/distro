# Changelog

## [Unreleased]

## [0.1.0] - 2026-10-27

### Added

- `lowland/machine` runs an SMP Linux kernel compiled to WebAssembly and
  exposes extensible machine lifecycle and virtio block, console, filesystem,
  network, vsock, and entropy device APIs.
- `lowland/guest` provides a bootable guest SDK with process execution and
  streaming I/O, and filesystem and mount operations. `guestAgent()` boots the
  agent as an initramfs and realizes a mount table, `mounts`, like fstab:
  disks and shared filesystems mounted `rw`, `ro`, or beneath a temporary
  writable overlay, with the entry at `/` as the root. A missing `type` is
  tried from the kernel's filesystems. `boot` replaces the default boot with
  your own calls, and `init` starts a program in the new root whose exit
  powers the machine off.
- `lowland/image` provides the canonical system image as the root of a mount
  table with `rootImage()`: a read-only EROFS root with BusyBox, apk-tools and
  CA certificates beneath a writable overlay, set up for the published apk
  repository. `rootImage(source)` boots a custom EROFS or ext4 image from a
  path, URL, `FileHandle`, bytes, `Blob` or `Response`.
- `diskStorage(source, { writable })` from `lowland/machine` opens a path, URL,
  `FileHandle`, bytes, `Blob`, `Response` or `BlockStorage` as block storage,
  rejecting only HTML error pages and partial sectors.
- `buildImage()` from `lowland/image/build` builds custom images in Node from
  apk packages, host files and symlinks, in a builder machine shipped with the
  package. Images are compressed with deflate by default; `compression`
  selects `lzma` or `none`.
- `lowland` exports `Linux`, one API that boots a machine and runs
  commands in Node and in browsers. Its command line runs a command in a fresh
  machine with `npx lowland run`, sharing host directories (`-v`), setting the
  working directory (`-w`), CPUs and host networking, and giving interactive
  commands a guest terminal (`-t`). `npx lowland build` takes the same options
  as `buildImage()`.
- `guest.exec(argv, { terminal })` runs a process on a guest pseudoterminal as
  a session leader with job control, and `resize()` changes the terminal's
  size. `{ stdio }` connects its standard input, output and error to pipes,
  `/dev/null`, standard output (`2>&1`), or guest files.
- A guest whose boot fails makes `bootMachine()` reject with a
  `GuestBootError` that names the step, carries the system call's error as its
  `cause`, and holds the end of the kernel log, instead of panicking the
  kernel. An ext4 image whose journal needs recovery fails to mount from
  read-only storage in the kernel's own words.
- `machine.close()` runs the new optional `MachinePlugin.closing()` hooks, in
  reverse plugin order, before teardown. The guest agent uses it to sync
  guest filesystems, so writes to a writable disk survive the close.
  `guest.sync()` syncs on demand.
- The vsock device accepts guest-initiated connections: `listen(port,
  handler)` serves a host port for as long as the handler runs.
- The kernel mounts EROFS images compressed with deflate, LZMA or LZ4, and
  `mkImage` compresses EROFS images with deflate by default.
- The toolchain supports C++ exceptions, so btop builds. `buildGoModule`
  builds Go programs for `linux/wasm`, and `buildGoModuleCgo` adds static
  cgo. The apk repository adds socat.
- `nix develop github:tombl/distro#sdk` gives a shell whose compilers, CMake
  and Meson target the guest, and `nix flake init -t github:tombl/distro#port`
  starts a downstream project with a package, an image and a boot script.
- `ptrace()` requests after `PTRACE_TRACEME` or `PTRACE_ATTACH` work instead
  of killing the tracer, and `<linux/ptrace.h>` builds in userspace.
- musl defines syscall numbers 451–471 and provides `swapon()`, `swapoff()`,
  and `pthread_getattr_np()` on the main thread.
- Documentation and runnable examples are published at https://docs.low.land.
- Node and browser virtio-fs adapters share host directories with guests,
  including backend-enforced read-only mounts and support for OPFS and the
  browser File System Access API.
- Virtual Ethernet and an opinionated host IPv4 stack connect multiple guests
  and provide TCP, UDP, DNS, HTTP/Fetch adapters, and access to host TCP
  services through configurable connectors.
- Browser block devices can be served from filesystem workers, allowing
  persistent OPFS-backed disks without keeping storage I/O on the main thread.
- The Node runner boots a tested interactive userland and supports repeatable
  read-write and read-only host directory shares.
- Multi-process workloads support `posix_spawn()`, private user memory, and
  kernel-backed POSIX named semaphores without relying on `fork()` or `mmap()`.

### Changed

- Updated the WebAssembly architecture port to Linux 7.1 and moved immutable
  system images from SquashFS to EROFS.
- **Breaking:** Lowland is one npm package, `lowland`, with an entry point
  per layer, instead of the `@lowland/kernel`, `@lowland/guest` and
  `@lowland/image` placeholders. `@lowland/kernel` is `lowland/machine`, which
  also exports the plugin API from `@lowland/kernel/plugin`. `@lowland/guest`
  is `lowland/guest`, with `NodeFS` in `lowland/node` and `BrowserFS` in
  `lowland/browser`. `@lowland/image` is `lowland/image` and
  `lowland/image/build`. The binary-data helpers are internal source. Each
  entry point loads only its own assets, so an application bundles the
  canonical image only if it imports `lowland/image`, and `Linux.create()`
  needs an `image`: `rootImage()` for the canonical one, or your own.
- **Breaking:** `lowland/machine` no longer exposes its virtio layer. Custom
  devices built on `VirtioController`, `VirtioDriver`, `VirtioDeviceOptions`,
  `VirtqueueHandler`, and the `Virtqueue*` types are no longer supported, and
  `DeviceTreeNode` and `MachineSetup.deviceTree` are removed. Devices are typed
  as the opaque `Device`, and `VsockDevice.close()` is removed because the
  machine owns device lifetime. `BlockDeviceStorage` is renamed `BlockStorage`.
- **Breaking:** the plugin provider key `getMachinePlugin` is renamed
  `machinePlugin`.
- Virtio-net no longer drops frames for a guest that has fallen behind. Past a
  small backlog, a unicast `EthernetPort.send()` waits until the guest accepts
  the frame, so awaiting senders are throttled to the guest's pace. Floods
  never wait for a stalled port.
- Console input is read from its stream only as the guest consumes it.
- Block devices hand storage the guest's memory directly instead of copies,
  offer `VIRTIO_BLK_F_SEG_MAX` so requests carry up to 128 segments, process
  independent requests concurrently, and move each request in as few storage
  calls as possible, using the new optional `BlockStorage.readv()` and
  `writev()` when present. A flush waits for every earlier write. Storage
  must not touch the arrays it was given after its call settles.
- **Breaking (kernel ABI):** the `virtio.reset` import takes the address of a
  word the host sets once a device has finished with guest memory, and the
  kernel waits for it before reusing that memory. The kernel and
  `lowland/machine` must be updated together.

- **Breaking:** `/bin/sh` in images is BusyBox ash instead of hush, as on
  Alpine, so scripts get `set -u` and `set -e` behaves as POSIX requires.
- Published packages require Node 24.20 or later on 24.x, or 26.7 or later.
  Earlier releases' `Duplex.toWeb()` never ends a half-closed peer's stream,
  or throws when the converted stream closes, which breaks guest TCP and
  image builds.
- Virtio-fs reads each directory once per handle, writes replies straight
  into guest memory, and forgets or renames only the affected subtree.
  `NodeFS` no longer syncs on every `close()`; `fsync()` still syncs.
- Device-writable virtio buffers are allocated on first touch instead of
  copied out of guest memory, which makes boot faster.
- Node kernel threads no longer load undici to receive their first message.
- A missing system disk fails the boot at once instead of after 11 seconds of
  polling.
- `lowland/guest` rejects an `agent.cpio` that is not a newc archive, such
  as a dev server's HTML fallback page, with an error naming the URL, and
  retries a failed load.

### Fixed

- Made machine shutdown, virtio reset, in-flight queue handling, and device
  cleanup safe and deterministic.
- Fixed SMP synchronization and stale shared-memory views during cross-worker
  process and virtio handoffs.
- Preserved console input supplied during early boot and made console ownership
  transfers and resets reliable.
- Fixed `ADB integrity error`s when an apk package was rebuilt: the
  repository publishes content-addressed package files.
- Fixed processes without a console receiving each other's standard
  descriptors, which made `exec()` of a missing program resolve instead of
  rejecting with `ENOENT`.
- Fixed outbound TCP sessions aborting on every close: each direction now
  half-closes, and the session signal aborts only on reset.
- Fixed BrowserFS losing nodes when namespace operations overlap, and losing
  writes to a file that a rename was moving.
- Fixed `copy_from_user()` and `copy_to_user()` copying nothing when a range
  ran off the end of process memory, which hung writes and failed reads that
  should have been short.
- Fixed `sigsuspend()`, `ppoll()` and `pselect()` leaving their temporary
  signal mask installed after a handler ran.
- Fixed signal handlers that leave through `siglongjmp()` or a C++ `throw`
  overrunning the kernel stack, and kept guest exception handlers from
  catching `exit()` and `exec()`.
- Fixed `clone()` without `CLONE_VM` failing with `EOPNOTSUPP` while another
  process read the caller's `/proc` entries.
- Fixed futexes in separate address spaces waking each other's waiters when
  they shared an address.
- Fixed HTTPS `wget` exiting with status 139 after a successful download.
- Fixed writes through unbuffered `FILE` streams failing with `EINVAL` on
  files such as `/proc/<pid>/oom_score_adj`.
- Fixed `SIZE_MAX` and the other pointer-sized limits having `int`'s type
  instead of `long`'s.
- Fixed image files losing their requested modes: `files` with 0600 came out
  0644, and setuid modes failed the build.
- Fixed a tmpfs file truncated up from empty allocating all of its pages at
  once: it grows sparsely, and tmpfs supports `fallocate()`.

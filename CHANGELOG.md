# Changelog

## [Unreleased]

### Added

- `@lowland/kernel` runs an SMP Linux kernel compiled to WebAssembly and
  exposes extensible machine lifecycle and virtio block, console, filesystem,
  network, vsock, and entropy device APIs.
- `@lowland/guest` provides a bootable guest SDK with process execution and
  streaming I/O, filesystem and mount operations, labeled EROFS or ext4 root
  disks, and optional temporary writable overlays.
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
- Published packages bundle their private binary-data helpers so applications
  only need to install the public kernel and guest packages.

### Fixed

- Made machine shutdown, virtio reset, in-flight queue handling, and device
  cleanup safe and deterministic.
- Fixed SMP synchronization and stale shared-memory views during cross-worker
  process and virtio handoffs.
- Preserved console input supplied during early boot and made console ownership
  transfers and resets reliable.

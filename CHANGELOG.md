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
- **Breaking:** `@lowland/kernel` no longer exposes its virtio layer. Custom
  devices built on `VirtioController`, `VirtioDriver`, `VirtioDeviceOptions`,
  `VirtqueueHandler`, and the `Virtqueue*` types are no longer supported, and
  `DeviceTreeNode` and `MachineSetup.deviceTree` are removed. Devices are typed
  as the opaque `Device`, and `VsockDevice.close()` is removed because the
  machine owns device lifetime. `BlockDeviceStorage` is renamed `BlockStorage`.
- Virtio-net no longer drops frames for a guest that has fallen behind. Past a
  small backlog, a unicast `EthernetPort.send()` waits until the guest accepts
  the frame, so awaiting senders are throttled to the guest's pace. Floods
  never wait for a stalled port.
- Console input is read from its stream only as the guest consumes it.
- Block devices process independent requests concurrently and make one
  storage call per request. A flush waits for every earlier write.

### Fixed

- Made machine shutdown, virtio reset, in-flight queue handling, and device
  cleanup safe and deterministic.
- Fixed SMP synchronization and stale shared-memory views during cross-worker
  process and virtio handoffs.
- Preserved console input supplied during early boot and made console ownership
  transfers and resets reliable.

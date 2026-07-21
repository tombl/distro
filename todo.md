# Roadmap

- Fix `futex_waitv` on wasm. Syscall 449 returns `EFAULT` for a valid
  stack-resident `struct futex_waitv`, while the equivalent plain
  `FUTEX_WAIT` succeeds. Add the upstream test to the green kselftest set with
  the kernel fix.
- Add framebuffer and input support with guest-visible integration tests; add
  DRM only when its userspace memory requirements are supportable.
- Add outbound UDP to the networking layer.
- Add TCP retransmission. The userspace bridge currently sends each data
  segment once and fails its exact-ACK waiter after 30 seconds; the virtio-net
  receive path tail-drops after 256 queued frames, so loss is possible.
- Revisit x86 execution and guest Node.
- Remove musl's unused generic `_start_c`; section GC currently hides its
  undefined reference to `main`.
- Fix System V IPC on wasm. The defconfig currently omits `CONFIG_SYSVIPC`.
  Enabling it builds the generic message, semaphore, and shared-memory
  implementation, but the first `shmget(IPC_PRIVATE, 4096, IPC_CREAT | 0600)`
  traps with an out-of-bounds access in `ipcget()`:

  ```
  RuntimeError: memory access out of bounds
      at vmlinux.o.ipcget
      at vmlinux.o.sys_shmget
      at vmlinux.o.wasm_syscall
  ```

  Once fixed, enable the config and restore util-linux's `ipcmk`, `ipcrm`,
  `ipcs`, and `lsipc` plus their create/list/remove VM coverage.


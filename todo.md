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

## Known-failing LTP kernel gaps

Re-enable these tests as the corresponding kernel fixes land:

- `getcwd01` (`TFAIL`)
- `lseek11` (`TCONF`)
- `brk01`
- `clock_gettime01`
- `getrandom01`
- `nice05` (hangs the VM watchdog)

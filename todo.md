# Roadmap

- Fix `futex_waitv` on wasm. Syscall 449 returns `EFAULT` for a valid
  stack-resident `struct futex_waitv`, while the equivalent plain
  `FUTEX_WAIT` succeeds. Add the upstream test to the green kselftest set with
  the kernel fix.
- Add framebuffer and input support with guest-visible integration tests; add
  DRM only when its userspace memory requirements are supportable.
- Add outbound UDP to the networking layer.
- Revisit x86 execution and guest Node.
- Remove musl's unused generic `_start_c`; section GC currently hides its
  undefined reference to `main`.

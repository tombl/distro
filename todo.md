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

## Validation suites

- Re-enable known-failing LTP tests as kernel gaps are fixed: `getcwd01`
  (`TFAIL`), `lseek11` (`TCONF`), `brk01`, `clock_gettime01`, `getrandom01`,
  and `nice05` (watchdog hang).

## Test infrastructure

- Fix `vm-test/run-test.js` settling on console close and masking later machine
  errors.
- Make basic-init's clone-job-control test fail rather than falling back to
  `SIGSTOP`.
- Return guest address suffixes to the pool instead of imposing a 253-spawn
  cap.

## Platform constraints

- Track wasm guest-process teardown retaining host emulator memory. Repeated
  guest process spawns cause host RSS to grow cumulatively instead of returning
  to a steady state; this is a platform lifecycle constraint, not a Bash defect.

## Package follow-ups

- Complete static `libmagic.pc` metadata for consumers.
- Complete static `libjq.pc` metadata for consumers.

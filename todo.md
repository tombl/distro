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

## Known-failing LTP kernel gaps

Re-enable these tests as the corresponding kernel fixes land:

- `getcwd01` (`TFAIL`)
- `lseek11` (`TCONF`)
- `brk01`
- `clock_gettime01`
- `getrandom01`
- `nice05` (hangs the VM watchdog)

## Review follow-ups

- Fix wasm guest-process teardown retaining emulator memory. A VM check that
  launched each of coreutils' 107 binaries with `--version` grew the host
  `MainThread` to about 49.8 GiB RSS (937 GiB virtual) before the OOM killer
  terminated it. The last printed iteration was `nproc`, around the 57th
  process; `nproc --version` succeeds by itself, so it appears to be cumulative
  process-lifecycle state rather than that utility.

  Minimal guest-side repro, using the coreutils VM image:

  ```sh
  i=0
  while :; do
    i=$((i + 1))
    echo "exec $i"
    /gnu/bin/true --version >/dev/null || exit
  done
  ```

  Run it as the init script of `coreutils.passthru.checks.programs` and watch
  the host Node process's RSS. The packaging check now verifies the full path
  inventory without execing every binary, but this needs a focused host-runtime
  regression test that asserts memory returns to a steady state after guest
  process exit.
- Subprocess `close_fds` has an fd-snapshot race (document-only for now).
- `vm-test/run-test.js` settles on console close and can mask later machine errors.
- The basic-init clone-job-control test falls back to `SIGSTOP` instead of failing.
- kselftest suites can false-pass on TAP skips and textual `FAIL`s (`mq_open`, `pidfd`).
- Virtio console resize is not exercised end-to-end by the PTY check.
- Guest address suffixes are never returned to the pool (253-spawn cap).
- Static-library metadata (`libjq.pc`, `libmagic.pc`) is incomplete for consumers.
- Per-commit `flake.lock` carries undeclared future inputs (bisect dirt).
- Add a build-time store-path scanner for guest slices via `allowedReferences = []` with a dev-output split (host vs guest derivation classification).
- The browser CPU-handoff test races: the host throws RangeError building a typed-array view (likely stale buffer after concurrent memory growth); intermittent regardless of build load. Fix belongs in the linux host runtime.
- npm release staging needs a version bump flow (deliberate, handled at release time).

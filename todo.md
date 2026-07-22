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

## Review follow-ups

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
- Examples category: test like consumers consume - npm install the literal publish tars into esm/vite/nextjs example projects using standard ecosystem tooling including tests, insulated from nix, CI-wired
- browser-tests firefox 'guest agent did not become ready' flake seen in CI 2026-07-22 - watch and root-cause if it recurs
- Enable the machine debug flag inside CI browser checks so boot-readiness
  flakes ("guest agent did not become ready") leave a progress trace instead
  of an opaque timeout.

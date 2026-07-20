# Roadmap

## Now

1. Land the three-argument-main toolchain change (clang overload mangling +
   musl crt weak-forwarder dispatch): blocked on the lld `parseLazy`
   local-symbol fix (upstream bug, exposed by the musl crt restructure moving
   archive extraction order; symptom was an invalid busybox module). Then:
   push the lld fix, bump the llvm and musl pins, drop the make/platform
   workarounds, full flake check.
2. Land bash round 2 (process substitution, coprocesses, forced null-command,
   `/dev/fd -> /proc/self/fd` in rootfs and vm-test init) once revalidated
   against the fixed toolchain.
3. Kernel-backed POSIX named semaphores (`/dev/wasm-sem`-style object with
   full open/unlink/wait/post/getvalue semantics) plus musl `sem_open`
   dispatch, then the spawn-based Python multiprocessing subset (Queue, Pool,
   ProcessPoolExecutor). Research and phase plan:
   docs/posix-semaphores-multiprocessing-research.md (in the semaphores
   worktree until landed).
4. Decide the browser-tests landing: packages/browser-tests with a GitHub
   Actions three-engine matrix is review-ready; merge as an
   engine-integration smoke harness, or keep as a reference branch. The
   JSC-cage OOM regression could not be reproduced decisively through the
   packaged runtime in a browser (WPE's multi-process address-space baseline
   is far above the limit that made the bun repro deterministic).

## Later

- Land framebuffer and input support with guest-visible integration tests, then add basic DRM only when its userspace memory requirements are supportable.
- Add outbound UDP and browser `fetch` transports to the networking layer.
- Package a useful initial software set and document the Nix-to-JavaScript build path.
- Revisit x86 execution and guest Node after the core SDK is reliable.
- Drop the dead generic `_start_c` (and its undefined reference to `main`)
  from musl's wasm32 crt1: it only links because section GC discards it, and
  it was a confusing red herring during the busybox link regression.

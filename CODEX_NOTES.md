# Codex notes

## Implementation

- Changed `linux-src` from `safari-memory` to
  `chromium-buffer-refresh` and pinned the lock to
  `4fdc7a01ace239a5b65886f8b556c1650d406a83` with NAR hash
  `sha256-9RRrHBg9Fn7LlYFafQJnadcht90j3w8MR8Lq+2OLwUQ=`.
- Added a documented `SpawnGuestOptions.debug` option, defaulting to `false`,
  and passed it explicitly to `spawnMachine`. `linux-guest` does not have its
  own worker layer or diagnostics, so no additional logging was added.
- Added runner `--debug` and `LINUX_DEBUG=1` support. Their values are ORed,
  and `--help` documents both entry points.
- Parsed the site's `?debug` parameter once in each guest-booting module and
  passed it to the hero guest, landing-page peer guests, and documentation demo
  guests.
- Applied
  `/home/tom/.claude/jobs/334f0557/tmp/fix-isolation-test.patch` cleanly with
  `patch -p1`. It adds the static `user-trap` fixture and verifies that a guest
  WebAssembly trap becomes SIGSEGV only for the offending process while the
  guest and a concurrent process survive.
- Added a Playwright stale-buffer regression. The page-level helper contains
  the minimal cross-worker shared-memory grow/view proof, and the spec links to
  it before running the kernel-backed scheduler handoff workload. The same spec
  runs for Chromium, Firefox, and WebKit and has a 30-second timeout.
- Appended the two requested follow-ups to `todo.md`.

`nix flake update linux-src` was run after changing the ref. At validation time
the remote branch still advertised `ca6ab27f0c1c5033ef86265de17060cd7b26cc35`,
while the requested commit existed in the local Linux checkout but was not yet
advertised by GitHub. The lock was therefore restored explicitly to the
requested full revision using the NAR hash from the local Git object. All final
validation used `--no-write-lock-file`, and `nix flake metadata
--no-write-lock-file --json` resolved `linux-src` to the requested revision.

## Validation

Requested checks:

- `nix build --no-link --no-write-lock-file
  .#checks.x86_64-linux.linux-guest-package-check-tests-integration` — passed
  on the final run: 50 tests, 50 passed. The new trap-isolation test passed.
- `nix build --no-link --no-write-lock-file
  .#checks.x86_64-linux.browser-tests-check-chromium` — passed, 3 tests.
- `nix build --no-link --no-write-lock-file
  .#checks.x86_64-linux.browser-tests-check-firefox` — passed, 3 tests.
- `nix build --no-link --no-write-lock-file
  .#checks.x86_64-linux.browser-tests-check-webkit` — passed, 3 tests.
- `nix build --no-link --no-write-lock-file
  .#checks.x86_64-linux.runner-image-check-mount` — passed with
  `::vm-test::pass`.
- `nix build --no-link --no-write-lock-file
  .#checks.x86_64-linux.formatting` — passed.

The stale-buffer spec passed by itself in Firefox in 2.3 seconds. The final
full three-test suites took 21.3 seconds in Chromium, 28.5 seconds in Firefox,
and 19.4 seconds in WebKit. The deliberately unsynchronised pure-JS observation
varied by engine and run, as expected: runs saw both current 9,895,936-byte
wrappers and stale 9,371,648-byte wrappers that refreshed to 9,895,936 bytes.
The kernel-backed handoff passed in every final engine run.

Additional checks:

- `nix build --no-link --no-write-lock-file .#site` — passed; Astro reported 0
  errors, warnings, or hints and built all 5 pages.
- `nix flake check --no-build --show-trace` — passed evaluation for the local
  system.
- `nix fmt` — completed successfully before the formatting check.

Runner smoke test:

- Built `.#runner` and ran it with `LINUX_DEBUG=1` for a short boot. It emitted
  `[linux]` lines including `machine spawn`, worker `spawn`, and worker
  `register` events.
- Repeated the same short boot without the environment variable. It produced
  no `[linux]` matches. The guest's ordinary boot console remains independent
  of the host debug stream.

During validation, the first integration run reached 50 tests but the existing
session-teardown test timed out connecting to vsock (48 passed); the immediate
final rerun passed all 50 in 38.3 seconds. An initial Firefox suite run also
stalled after the first two tests; the stale-buffer spec then passed alone in
2.3 seconds and the complete Firefox rerun passed in 25.4 seconds. These
one-off readiness stalls are recorded rather than hidden, consistent with the
new Firefox flake follow-up in `todo.md`.

# Browser tests

This package boots the packaged `@tombl/linux-guest` runtime in Playwright's
Chromium, Firefox, and WebKit builds. The server supplies the COOP and COEP
headers required by shared WebAssembly memory. Browser binaries, fonts, npm
packages, rootfs, initramfs, and kernel assets all come from Nix store paths;
the tests do not fetch anything at runtime.

The npm `@playwright/test` version is an exact pin. `package.nix` compares it
with `playwright-driver.version` at evaluation time and fails with both
versions in the error if they differ.

## Running

All engines run outside the Nix build sandbox through the same flake app:

```console
nix run .#browser-tests -- --project=chromium
nix run .#browser-tests -- --project=firefox
nix run .#browser-tests -- --project=webkit
```

Omit `--project` to run all three. CI uses a Chromium/Firefox/WebKit matrix
with this entry point, and the completed matrix gates site deployment and npm
release staging. There are deliberately no browser flake checks.

The suite is a boot smoke test: `spawnGuest` → `exec uname` → clean
`machine.closed`, once per engine. It catches SAB/COOP/COEP/worker/
module-loading regressions that only show up on a real browser engine, which
the Nix-sandboxed VM checks cannot exercise.

## Sandbox feasibility

The following results were measured on x86_64 Linux with nixpkgs Playwright
1.61.1 and its packaged browser revisions.

| Engine | Nix build sandbox | Result |
| --- | --- | --- |
| Chromium | feasible | Boot, `uname -a`, and clean `machine.closed` passed. |
| Firefox | feasible | Boot, `uname -a`, and clean `machine.closed` passed. |
| WebKit | infeasible | The browser process launched, but `browserContext.newPage()` timed out after 180 seconds. |

The WebKit sandbox failure was repeatable with the full nixpkgs WebKit closure,
fontconfig configured from the store, a writable HOME/XDG setup, and
`WEBKIT_DISABLE_DMABUF_RENDERER=1`. WebKit logged that automation was not
allowed in the context and fell back to the default session, along with EGL
driver warnings. Disabling the dma-buf renderer did not change the timeout:

```text
Test timeout of 180000ms exceeded while setting up "page".
Error: browserContext.newPage: Test timeout of 180000ms exceeded.
WebKitWebView is-controlled-by-automation set but automation is not allowed in the context, falling back to default session.
```

The same WebKit package passed the boot smoke outside the sandbox in 9.9
seconds. Chromium and Firefox could be restored as sandboxed checks, but doing
so would create two execution models for one suite. All three therefore run
through the app for consistent local and CI behaviour.

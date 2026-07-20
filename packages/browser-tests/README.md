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

Each engine is an ordinary flake check and runs inside the Nix build sandbox:

```console
nix build .#checks.x86_64-linux.browser-tests-check-chromium -L
nix build .#checks.x86_64-linux.browser-tests-check-firefox -L
nix build .#checks.x86_64-linux.browser-tests-check-webkit -L
```

The generic check discovery in `checks.nix` exposes these checks and the
generic CI build matrix runs them. There is no separate browser-test app or CI
job.

The suite is a boot smoke test: `spawnGuest` → `exec uname` → clean
`machine.closed`, once per engine. It catches SAB/COOP/COEP/worker/
module-loading regressions that only show up on a real browser engine.

## Headless graphics

The checks use nixpkgs' Mesa EGL vendor and DRI drivers with software
rendering. This keeps the browser environment independent of host GPU drivers
and works on GitHub's Ubuntu runners, inside the Nix sandbox, and on NixOS
without relying on `/run/opengl-driver`.

# Browser tests

This package boots the packaged `@lowland/guest` runtime in Playwright's
Chromium, Firefox, and WebKit builds. The server supplies the COOP and COEP
headers required by shared WebAssembly memory. The workspace packages come
from their `dist/` builds, and the images the scenarios boot come from the
test assets; the tests do not fetch anything else at runtime.

## Running

From a checkout:

```console
pnpm artifacts && pnpm -r build    # once, from the repository root
pnpm --filter=@lowland/browser-tests test --project=chromium
```

The server reads images from `$LOWLAND_TEST_ASSETS`, or builds
`.#test-assets` on first use when it is unset.

`playwright.config.js` has one project per engine, plus two Chromium-only
projects with their own served roots:

- `service-worker` exercises the site's service worker, served from
  `apps/site/service-worker.js`.
- `site-live` runs against the built site (`node server.js --site`), installing
  from the candidate apk repository rather than production.

Each project is an ordinary flake check that runs the same `pnpm test` in the
Nix build sandbox, with nixpkgs' browser builds and only the assets it needs:

```console
nix build .#checks.x86_64-linux.browser-tests-check-chromium -L
```

The browser builds belong to one Playwright release, so the check fails early
if the `@playwright/test` version in the pnpm catalog differs from nixpkgs'
`playwright-driver`.

## Headless graphics

The checks use nixpkgs' Mesa EGL vendor and DRI drivers with software
rendering. This keeps the browser environment independent of host GPU drivers
and works on GitHub's Ubuntu runners, inside the Nix sandbox, and on NixOS
without relying on `/run/opengl-driver`.

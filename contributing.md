# Contributing

## Prerequisites

- A Linux host with flake-enabled [Nix](https://nixos.org/download). Nix
  bootstraps every other dependency, including the `just` command runner and
  toolchains.
- Clone this repository and enter `nix develop` (or
  `echo 'use flake' > .envrc && direnv allow`, if you use direnv) to get the
  pinned environment.

## Repository layout

- `packages/*/package.nix`: package definitions for wasm32-linux.
- `overrides/*/src`: ejected sources for packages you are actively hacking on.
- `all-packages.nix`: top-level package set wiring together the wasm packages
  and their overrides.
- `host-packages.nix`: mirrors the wasm packages with their nixpkgs equivalents
  for cross-compilation.
- `flake.nix`: entry point for developing and building with Nix flakes.

## Building and running

- `just run` builds and starts the system in your terminal. Run
  `just run --help` for debug flags and host integration options.
- `just serve` hosts the same site published at https://linux.tombl.dev so you
  can poke it locally with browser devtools.
- `just build <pkg>` rebuilds only the package you name after you have ejected
  it (see below). Use this for iteration on specific components.

## Working with overrides

- `just eject <pkg>` copies the upstream source for that package into
  `overrides/<pkg>/src`.
- Once ejected, subsequent `just build <pkg>` invocations compile from the
  override outside the Nix sandbox, so normal incremental build tools keep
  working.

## Debugging tips

- Enable DWARF debugging information by setting `config.debug = true` in
  `all-packages.nix` before rebuilding.
- Use Chrome DevTools with the
  [DWARF debug extension](https://goo.gle/wasm-debugging-extension)

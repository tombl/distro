# Contributing

## Prerequisites

- A Linux host with flake-enabled [Nix](https://nixos.org/download). Nix
  bootstraps every other dependency, including the toolchains.
- Clone this repository and enter `nix develop` (or
  `echo 'use flake' > .envrc && direnv allow`, if you use direnv) to get the
  pinned environment.

## Repository layout

- `packages/default.nix`: the wasm32 package scope. This attrset is the
  product; every package is listed here.
- `packages/*/package.nix`: package definitions, written like nixpkgs packages
  against the scope's wasm `stdenv`.
- `packages/stdenv.nix`: the wasm stdenv — nixpkgs' generic stdenv with our
  fork toolchain behind its cc-wrapper.
- `flake.nix`: pins nixpkgs and every package source, and instantiates the
  scope.

## Package outputs

Target derivations are FHS-shaped filesystem fragments rooted at `$out`, not
bare collections of build artifacts. Static linkage makes libraries in
`buildInputs` build-time dependencies, but packages may still need a
dependency's data or programs at runtime. In that case, overlay the dependency
into the package's own output during installation. An image should be able to
include a package without separately knowing its transitive runtime needs.

Runtime overlays must not contain conflicting paths. If two fragments need to
provide the same path, resolve that ownership in the packages rather than
depending on image composition order.

## Building and running

- **Stage new files before running any Nix command.** Flakes copy a Git worktree
  through the dirty-tree fetcher, which includes tracked edits but silently
  omits untracked files. Run `git add <new-file>` before `nix build`,
  `nix develop`, `nix fmt`, or `nix flake check`; otherwise a build can pass
  without seeing the file you just added.
- `nix run` builds and starts the system in your terminal. Run
  `nix run . -- --help` for debug flags and host integration options.
- `nix run .#serve` hosts the same site published at https://linux.tombl.dev so
  you can poke it locally with browser devtools.
- `nix build .#<pkg>` builds one package; `nix flake check` builds every VM and
  formatting check.

Use `scripts/check.sh [REGEX]` for the normal check loop. It selects checks by
attribute-name regex, intent-adds untracked files so Nix sees them, and uses
matching repositories under `checkouts/` as source overrides by default. Pass
`-n N` to sample flaky checks or `--no-overrides` to test the locked sources.

## Formatting

Run the repository formatter before sending changes:

```
nix fmt
```

This runs the same formatter set as the flake's formatting check.

## Working on dependencies

Every source (linux, musl, busybox, llvm, sqlite) is a flake input, so point
any of them at a local checkout with:

```
nix build .#musl --override-input musl-src ~/src/distro/checkouts/musl
```

For toolchain-sized dependencies where a clean rebuild is too slow, work inside
the package's own environment instead: `nix develop .#llvm-toolchain-unwrapped`
gives a shell with the exact compilers and flags, and cmake/ninja keep their
incremental state in your checkout.

## Debugging tips

- Enable DWARF debugging information for a single package with
  `wasmpkgs.busybox.override { stdenv = wasmpkgs.stdenvDebug; }`, or for the
  whole scope by importing `./packages` with `debug = true`.
- Use Chrome DevTools with the
  [DWARF debug extension](https://goo.gle/wasm-debugging-extension)

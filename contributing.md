# Contributing

## Prerequisites

- A Linux host with flake-enabled [Nix](https://nixos.org/download). Nix
  bootstraps every other dependency, including the toolchains.
- Clone this repository and enter `nix develop` (or
  `echo 'use flake' > .envrc && direnv allow`, if you use direnv) to get the
  pinned environment.

## Repository layout

- We use https://github.com/numtide/blueprint as our flake entrypoint. See
  https://numtide.github.io/blueprint/main/getting-started/folder_structure/ for
  the full details, but the gist of it is as follows:
  - `packages/<pkg>/default.nix` maps to `packages.<system>.<package>`
  - `devshells/<name>.nix` maps to `devShells.<system>.<name>`
  - just remember to `git add` new files if you want them to show up!

## Building and running

- `nix run .#runner` builds and starts the system in your terminal. Run
  `nix run .#runner -- --help` for debug flags and host integration options.
- `nix run .#serve` hosts the same site published at https://linux.tombl.dev so
  you can poke it locally with browser devtools.
- `nix build .#<pkg>` rebuilds only the package you name. For example,
  `nix build .#linux`.

## Working with local sources

- Package sources come from flake inputs.
- To temporarily build against a local checkout without editing `flake.nix`, pass
  an absolute `path:` input override:
  `nix build .#linux --override-input linux-src path:/home/you/src/linux`.
- For longer-lived local iteration, change the relevant source input in
  `flake.nix` to an absolute path URL, for example:
  `linux-src.url = "path:/home/you/src/linux";`.

## Debugging tips

- Enable DWARF debugging information by setting `debug = true` in `config.nix`
  before rebuilding.
- Use Chrome DevTools with the
  [DWARF debug extension](https://goo.gle/wasm-debugging-extension)

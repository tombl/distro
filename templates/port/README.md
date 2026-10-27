# hello

This project ports a small C program to Linux on WebAssembly. It builds the
program for the guest, installs it into a bootable root filesystem image, and
boots that image under Node to run the program.

## Requirements

The build requires Nix with flakes enabled. Nix installs on any Linux
distribution. On macOS, the guest packages are Linux derivations, so they
build on a Linux builder such as the
[nixpkgs Linux builder](https://nixos.org/manual/nixpkgs/unstable/#sec-darwin-builder).
The boot script requires Node 24 or later.

## Building

```sh
nix build .#hello
nix build .#image
```

The flakes have no Darwin outputs, so on macOS add the builder's Linux system
to each `nix build` in this README, for example
`nix build --system aarch64-linux .#image`, or `x86_64-linux` for an Intel
builder.

`hello` is the program alone. `image` is an EROFS root filesystem that
contains BusyBox and `hello`, and `result` links to it.

## Running

```sh
npm install
node boot.mjs result
```

Until `lowland` has a release on npm, the registry only holds an empty
placeholder. Install the package from the distro flake instead:

```sh
lowland=$(nix build --no-link --print-out-paths github:tombl/distro#lowland)
npm install "$lowland/package.tgz"
```

The script attaches the image as a block device, boots a machine with the
guest agent, and runs `hello` inside it.

## Porting a program

`package.nix` is an ordinary nixpkgs derivation. The scope's `stdenv`
cross-compiles for the guest and stages an installation for a root filesystem
rather than for the Nix store. The install prefix is `/` and `DESTDIR` is the
output, so `make install` places the program at `$out/bin/hello`, and the image
installs it at `/bin/hello`. Autotools, Meson, and CMake projects follow the
same convention.

Replace `src` with the program's source, for example a `fetchurl` of a release
tarball, and add its dependencies from the scope as `buildInputs`. Add the
result to the image's `packages` to install it.

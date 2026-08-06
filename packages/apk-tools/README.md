# apk-tools v3

apk is the guest package and root-filesystem installation model. Nix remains
the source build language: guest derivations build ordinary root-shaped
outputs, declare which outputs are binary APKs, and expose those artifacts as
`.apk` and `.apks` passthru attributes.

For the common single-output package:

```nix
stdenv.mkDerivation {
  pname = "example";
  version = "1.0";
  apk = {
    depends = [ (apk.virtual "cmd:sh") ];
  };
}
```

For one source build with multiple binary packages:

```nix
stdenv.mkDerivation {
  pname = "example";
  version = "1.0";
  outputs = [ "out" "dev" ];
  apkPackages = {
    main = { };
    dev.output = "dev";
  };
}
```

The normal derivation output remains suitable for guest `buildInputs`.
`example.apk` is the main native v3 APK and `example.apks.dev` is the
development APK. Non-main binary packages depend on the exact main package by
default. Build dependencies never become runtime dependencies implicitly:
guest software is statically linked, so APK dependencies are typed values made
with `apk.dep`, `apk.eq`, or `apk.virtual`.

The packaging layer infers versioned `cmd:*` providers from public executable
files and executable aliases, and infers common shebang interpreter
dependencies. BusyBox applet symlinks are deliberately not all advertised as
versioned command providers; `/bin/sh` is its package interface, while file
replacement packages use APK's `replaces` metadata.

`apk.mkRepository` accepts an attribute set of guest derivations or APKs. With
`includeDependencies = true`, it follows typed package dependencies to produce
a minimal repository closure. `apk.mkSystem` installs a selected world into a
root tree with the host apk implementation, including the native installed
database. `image.mkFilesystem` then encodes that tree as squashfs or ext4.
Product configuration and package selections are ordinary profile APKs made by
`apk.mkProfile`. A file can be a source directly, or carry explicit metadata as
`{ source = ./init.sh; mode = "0755"; }`.

Published repository membership lives under `packages/repositories/`; it does
not repeat package metadata. Product-local minimal repositories stay beside the
profile which selects them and use `includeDependencies = true`.

Host and guest apk-tools are both version 3.0.5. The target executable is
static and includes the CA bundle needed by bundled libfetch. Its wasm changes
disable mmap-backed file input and run package scripts/triggers through callback
`clone()` rather than `fork()`.

Repositories built by Nix are unsigned and local system construction uses
`--allow-untrusted`. Release signing remains outside Nix so a private key never
becomes a derivation input or enters the store.

Build the complete repository with:

```console
nix build .#legacyPackages.x86_64-linux.repository
```

The repository's install check boots a package-installed ext4 system, invokes
the target apk to install jq, Lua, and a scripted package from a nested local
repository, runs the programs, and verifies the target installed database.
Ordinary port checks use `vm-test.installedTest`, which builds the same minimal
profile → repository → installed system pipeline around their test fixtures.
Raw initramfs tests remain available for kernel behavior below the packaging
boundary and tests which need a separate scratch disk.

# apk-tools v3

apk is the guest package and root-filesystem installation model. Nix remains
the source build language: guest derivations are ordinary root-shaped outputs,
and packaging happens at the repository boundary rather than inside the stdenv.

`apk.mkPackage` turns a derivation into a native v3 APK. Name, version,
description, and Nix license metadata are used by default; overrides and
runtime metadata live on the derivation's `passthru.apk`. Guest software is
statically linked, so dependencies are only the declared runtime packages and
shared data:

```nix
stdenv.mkDerivation {
  pname = "example";
  version = "1.0";
  passthru.apk = {
    depends = [ "busybox" ];
    replaces = [ "busybox" ];
  };
}
```

`apk.mkRepository` accepts an attribute set of derivations or APKs and indexes
them. The single published `repository` contains all runtime packages and the
site boot payload. It is the runtime contract: a booted guest installs from the
same index, and `apk.mkSystem`
installs the same way at build time, so build-time and runtime installs cannot
diverge. `apk.mkSystem` takes repositories and a package selection, runs the
host apk implementation under fakeroot into a root tree (including the native
installed database), and layers product `files` and `links` on top.
`image.mkFilesystem` then encodes that tree as EROFS or ext4.

All guest checks use `vm-test.installedTest` or its installed-disk constructor.
They boot APK-installed systems through one generic boot initramfs; there is no
test-specific raw-initramfs path.

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

The repository checks boot package-installed ext4 systems. One invokes target
apk to install jq, Lua, and a scripted package from a nested local repository;
another installs Bash, coreutils, file, ncurses, and util-linux by name and
verifies their dependency, ownership, replacement, and removal behavior.

`replaces` permits the selected full userland package to overwrite a BusyBox
applet (and lets util-linux win its shared `kill` path over coreutils). apk does
not keep a stack of the overwritten bytes: removing the winner removes that
path. Run `apk fix` on the still-installed provider you want underneath—for
example, `apk fix coreutils` after removing util-linux—to restore its files.

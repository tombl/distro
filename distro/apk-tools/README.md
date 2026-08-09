# apk-tools v3

apk is the guest package and root-filesystem installation model. Nix remains
the source build language: guest derivations are ordinary root-shaped outputs,
and packaging happens at the repository boundary rather than inside the stdenv.

`apk.mkPackage` turns a derivation into a native v3 APK. Name and version are
read from the derivation; optional metadata lives on the derivation's
`passthru.apk`. Guest software is statically linked, so dependencies are only
the declared ones:

```nix
stdenv.mkDerivation {
  pname = "example";
  version = "1.0";
  passthru.apk = {
    depends = [ "cmd:sh" ];
    replaces = [ "busybox" ];
  };
}
```

`apk.mkRepository` accepts an attribute set of derivations or APKs and indexes
them. The published repository under `packages/repositories/` is the runtime
contract: a booted guest installs from the same index, and `apk.mkSystem`
installs the same way at build time, so build-time and runtime installs cannot
diverge. `apk.mkSystem` takes repositories and a package selection, runs the
host apk implementation under fakeroot into a root tree (including the native
installed database), and layers product `files` and `links` on top.
`image.mkFilesystem` then encodes that tree as squashfs or ext4.

Port checks use `vm-test.installedTest`, which builds a repository and installed
system around their test fixtures. Raw initramfs tests remain available for
kernel behavior below the packaging boundary.

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

# apk-tools v3

This port keeps Nix as the package build language and uses apk as the mutable
installation layer. `mkPackage` converts one rootfs-shaped derivation to a
native v3 `.apk`; `mkRepository` collects those packages and writes a native v3
`Packages.adb` index. The `repository` attribute contains the target package
fragments, while `demo.demoRootfs` is an ext4 image containing apk and a small
local repository.

The target build requires zlib and one crypto backend. This package uses the
existing OpenSSL port and apk-tools' bundled libfetch, so HTTP, HTTPS,
signatures, gzip/v2 input, and deflate-compressed v3 input are available. The
executable is static; its only packaged runtime data is the CA bundle. Package
scripts additionally require the interpreter named in their shebang, normally
`/bin/sh`.

Meson, Ninja, pkg-config, and Lua (for the embedded help database) are
build-platform tools. scdoc, target Lua/Python bindings, cmocka, and libzstd are
optional upstream dependencies for documentation, bindings, tests, and zstd
compression respectively; this port disables them. Repository artifacts use
deflate so the target does not need libzstd (the distro's `zstd` package
currently provides the CLI, not the library).

Two target adaptations are needed:

- mmap-backed file input is disabled. apk's existing fd-stream path handles
  package and index reads without changing their semantics.
- maintainer scripts and triggers use callback `clone()` instead of `fork()`.
  External URL helpers already use `posix_spawn()` upstream. The namespace
  capability probe is disabled on wasm; scripts still run in apk's chroot.

Build the complete repository with:

```console
nix build .#legacyPackages.x86_64-linux.apk-tools.repository
```

The Nix output is deliberately unsigned and the demo uses `--allow-untrusted`:
putting a private signing key in a derivation would copy it into the Nix store.
Sign the finished ADB artifacts outside Nix before publishing a trusted
repository.

Consumers can define a smaller repository directly:

```nix
let
  jqApk = wasmpkgs.apk-tools.mkPackage {
    package = wasmpkgs.jq;
  };
in
wasmpkgs.apk-tools.mkRepository {
  name = "my-repository";
  packages = [ jqApk ];
}
```

`depends`, `provides`, `replaces`, and `scripts` are explicit adapter inputs.
Static linkage means build inputs do not become apk dependencies, and existing
package fragments already copy required runtime data into their own outputs.
File ownership is stricter than ordered rootfs overlays: packages which shadow
BusyBox must declare `replaces = [ "busybox" ]`, and any other overlapping
fragments need the same ownership decision before they can be co-installed.

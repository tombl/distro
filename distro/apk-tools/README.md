# apk-tools v3

apk is the guest package and root-filesystem installation model. Nix remains
the source build language: guest derivations are ordinary root-shaped outputs,
and packaging happens at the repository boundary rather than inside the stdenv.

Every guest derivation becomes a native v3 APK at the repository or image
boundary. Name, version, description, and Nix license metadata are used by
default; overrides and runtime metadata live on the derivation's
`passthru.apk`. Guest software is statically linked, so dependencies are only
the declared runtime packages and shared data:

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

The single published `repository` contains every user-installable package and
the site boot payload; a booted guest installs from it. Internal guest programs
(the guest agent, test suites, smoke tests) are not published: images receive
them as derivations. Images are built with `mkImage` (documented in
`distro/image/default.nix`), which installs a package selection the same way at
build time: it resolves `depends` by name against the package scope, indexes
exactly that closure, runs the host apk implementation under fakeroot into a
root tree (including the native installed database), layers product `files` and
`links` on top, and encodes the tree as EROFS or ext4. The package, repository,
and system-install helpers in `distro/apk` are private to the scope.

All guest checks use `vm-test.installedTest` or `vm-test.installedDisk`, thin
wrappers over `mkImage`. They boot APK-installed systems through one generic
boot initramfs (`vm-test.bootInitramfs`); there is no test-specific
raw-initramfs path.

Host and guest apk-tools are both version 3.0.5. The target executable is
static and includes the CA bundle needed by bundled libfetch. Its wasm changes
disable mmap-backed file input and run package scripts/triggers through callback
`clone()` rather than `fork()`.

Repositories built by Nix are unsigned and local system construction uses
`--allow-untrusted`. Release signing remains outside Nix so a private key never
becomes a derivation input or enters the store.

Package files in every repository are content-addressed:
`<name>-<version>.<identity>.apk`, where the identity is the first 16 hex
digits of the package's v3 identity hash. The index records this as its
`pkgname-spec`, and apk builds each download URL from it, so the repository URL
stays `.../wasm32/Packages.adb`. A rebuild that changes a package's metadata or
any payload file without bumping its version still gets a new file name. The
publish script therefore uploads APKs once and serves them as immutable. A
rebuild that differs only in its archive representation, such as compression,
keeps its identity; the publish then fails rather than replace the file. `Packages.adb` is the
only object it replaces.

A replaced index stays under `retired/` for 7 days, and its APKs stay published
until then. After that, a guest still holding the old index
can get 404s for APKs that have since been pruned, until a successful
`apk update`. apk only refreshes an index older
than 4 hours during writable operations such as `apk add`, so `apk fetch` keeps
using a cached index however old it is.

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

# The Go toolchain for linux/wasm is a native compiler whose forked linker and
# runtime know the target. Keep the compiler on the build platform and teach
# nixpkgs' ordinary module builder about the wasm stdenv and target variables;
# building Go itself with GOOS=linux GOARCH=wasm would incorrectly try to make
# the host cmd/* tools into wasm executables.
{
  lib,
  pkgs,
  platform,
  stdenv,
  src ? pkgs.fetchFromGitHub {
    owner = "tombl";
    repo = "go";
    rev = "f6cf684d24c4d5fb5b396196eaff2a1f28a1ce7c";
    hash = "sha256-/tZtTfMf0J3gJLZO1zUyGtiUQZCC6+50LgVrKxy7ljk=";
  },
}:

let
  nativeGo = pkgs.go_1_27.overrideAttrs (
    _finalAttrs: previousAttrs: {
      pname = "go-wasm-linux";
      version = "1.27.0-port-f6cf684d24";
      inherit src;

      # Undo host-specific nixpkgs data-path substitutions for binaries that
      # will execute inside the FHS guest. The tagged source carries VERSION.
      postPatch = (previousAttrs.postPatch or "") + ''
        # nixpkgs patches its native Go runtime to use immutable database paths.
        # Those paths must not become runtime dependencies of FHS guest
        # binaries installed through APK.
        substituteInPlace src/net/lookup_unix.go \
          --replace-fail '${pkgs.iana-etc}/etc/protocols' '/etc/protocols'
        substituteInPlace src/net/port_unix.go \
          --replace-fail '${pkgs.iana-etc}/etc/services' '/etc/services'
        substituteInPlace src/mime/type_unix.go \
          --replace-fail '${pkgs.mailcap}/etc/mime.types' '/etc/mime.types'
        substituteInPlace src/time/zoneinfo_unix.go \
          --replace-fail '${pkgs.tzdata}/share/zoneinfo/' '/usr/share/zoneinfo/'
      '';
    }
  );

  # buildGoModule reads these attributes from its `go` argument. Adding them
  # to the derivation value does not rebuild the native compiler for the target.
  targetGo = nativeGo // {
    inherit (platform.system.go) GOOS GOARCH;
    CGO_ENABLED = 0;
    meta = nativeGo.meta // {
      platforms = [ platform.system.system ];
    };
  };

  # Static cgo uses the same native Go tools and target stdenv. The stdenv's
  # cc-wrapper supplies the wasm32 Linux triple, sysroot, atomics, shared
  # memory, and SJLJ flags; cgo then hands its relocatable wasm objects to the
  # forked Go linker. Keep this opt-in so packages without C dependencies retain
  # the reproducible pure-Go path and do not acquire libc startup implicitly.
  targetGoCgo = targetGo // {
    CGO_ENABLED = 1;
  };

  nixpkgsBuilder = pkgs.buildGo127Module.override {
    go = targetGo;
    inherit stdenv;
  };

  nixpkgsCgoBuilder = pkgs.buildGo127Module.override {
    go = targetGoCgo;
    inherit stdenv;
  };

  # Go's linker owns WebAssembly symbol/debug stripping. The wasm stdenv hook
  # invokes llvm-strip, which rejects Go 1.27 modules containing
  # custom sections between standard sections. Use the shell-string form so it
  # is exported into the derivation environment under structured attributes.
  disableHostStripping =
    attrs:
    {
      doCheck = false;
      dontStrip = "1";
    }
    // attrs;

  # The Go linker asks clang for a single relocatable wasm object before doing
  # the final executable link itself. stdenv's final-link environment contains
  # flags such as --export-table and --import-memory which wasm-ld rejects with
  # -r. The cc-wrapper still supplies the target sysroot and compiler features;
  # remove only the executable-shaping link variables for Go-driven builds.
  configureCgoPrelink =
    attrs:
    let
      configured = disableHostStripping attrs;
    in
    configured
    // {
      preBuild = (configured.preBuild or "") + ''
        unset NIX_CFLAGS_LINK NIX_LDFLAGS
      '';
    };

  # Cross-built tests cannot run during a normal derivation. Packages can opt
  # back in, but platform behavior belongs in explicit vm-test checks.
  buildGoModule = lib.makeOverridable (
    args:
    nixpkgsBuilder (
      if builtins.isFunction args then
        finalAttrs: disableHostStripping (args finalAttrs)
      else
        disableHostStripping args
    )
  );

  buildGoModuleCgo = lib.makeOverridable (
    args:
    nixpkgsCgoBuilder (
      if builtins.isFunction args then
        finalAttrs: configureCgoPrelink (args finalAttrs)
      else
        configureCgoPrelink args
    )
  );
in
{
  package = nativeGo;
  inherit
    src
    targetGo
    targetGoCgo
    buildGoModule
    buildGoModuleCgo
    ;
}

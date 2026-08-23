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
    rev = "1e03a85fde3886386560972e0e68d7e225c247a7";
    hash = "sha256-LqzxxUKqHSIEBAXBvG9rJ7j4pMf0q/7WDfb478BqO2I=";
  },
}:

let
  nativeGo = pkgs.go_1_27.overrideAttrs (
    _finalAttrs: previousAttrs: {
      pname = "go-wasm-linux";
      version = "1.27.0-port-1e03a85fde";
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

  nixpkgsBuilder = pkgs.buildGo127Module.override {
    go = targetGo;
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
in
{
  package = nativeGo;
  inherit src targetGo buildGoModule;
}

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
    rev = "fec8900c16bfaf7a3d36a5cf282fc10e135df53a";
    hash = "sha256-mawqs8ePLrvvqTSLB99teIuCaZLZLUa8OuOrUq1bxEU=";
  },
}:

let
  nativeGo = pkgs.go_1_27.overrideAttrs (
    _finalAttrs: previousAttrs: {
      pname = "go-wasm-linux";
      version = "1.27.0-port-fec8900c16";
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

  # Apply our defaults to every package while keeping the builder itself
  # overridable like nixpkgs' (`buildGoModule.override { stdenv = ...; }`).
  # __functor must return a plain lambda and __functionArgs must mirror the
  # builder for lib.isFunction, lib.functionArgs, and callPackage to see it.
  wrapBuilder = transform: builder: {
    __functor =
      _: args:
      builder (if lib.isFunction args then finalAttrs: transform (args finalAttrs) else transform args);
    __functionArgs = lib.functionArgs builder;
    override = newArgs: wrapBuilder transform (builder.override newArgs);
  };

  # nixpkgs only runs checkPhase when the build platform can execute the host
  # platform, so doCheck = true cannot run these cross-built tests either.
  # Platform behavior belongs in explicit vm-test checks.
  buildGoModule = wrapBuilder disableHostStripping nixpkgsBuilder;
in
{
  package = nativeGo;
  inherit src targetGo buildGoModule;
}

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
    rev = "1cb069694ffe524c4c46bd303b3657aa31a5be3e";
    hash = "sha256-QKnr9hhUWaZdjFkY092OIeHjSrR0WcjHBxFH77PU9OY=";
  },
}:

let
  nativeGo = pkgs.go_1_27.overrideAttrs (
    _finalAttrs: previousAttrs: {
      pname = "go-wasm-linux";
      version = "1.28-devel-1cb069694f";
      inherit src;

      # Development checkouts derive this from Git history. fetchFromGitHub has
      # no .git directory, so provide the version make.bash and cmd/go require.
      postPatch = (previousAttrs.postPatch or "") + ''
        printf '%s\n' 'devel go1.28-1cb069694f' > VERSION
      '';

      env = previousAttrs.env // {
        # Go tip requires the previous stable release as its bootstrap compiler;
        # nixpkgs' go_1_27 expression still bootstraps with Go 1.24.
        GOROOT_BOOTSTRAP = "${pkgs.go_1_26}/share/go";
        GOTOOLCHAIN = "local";
      };
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

  # Cross-built tests cannot run during a normal derivation. Packages can opt
  # back in, but platform behavior belongs in explicit vm-test checks.
  buildGoModule = lib.makeOverridable (
    args:
    nixpkgsBuilder (
      if builtins.isFunction args then
        finalAttrs: { doCheck = false; } // args finalAttrs
      else
        { doCheck = false; } // args
    )
  );
in
{
  package = nativeGo;
  inherit src targetGo buildGoModule;
}

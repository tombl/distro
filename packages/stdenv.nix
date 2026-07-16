# The wasm stdenv: nixpkgs' generic stdenv with our toolchain behind its
# cc-wrapper and wasm32-unknown-linux-musl as the host platform. This mirrors
# what pkgs/stdenv/cross does when nixpkgs itself cross-compiles, minus the
# bootstrap stages we don't need.
{
  pkgs,
  platform,
  llvm-toolchain,
  sysroot,
}:

let
  # The wrappers take their target from the stdenv they are instantiated with.
  stdenvNoCC = pkgs.stdenvNoCC.override { targetPlatform = platform.system; };

  bintools = pkgs.wrapBintoolsWith {
    bintools = llvm-toolchain;
    libc = sysroot;
    inherit stdenvNoCC;
    # Static-only target: there is no program interpreter.
    sharedLibraryLoader = null;
  };

  cc = pkgs.wrapCCWith {
    cc = llvm-toolchain;
    libc = sysroot;
    inherit bintools stdenvNoCC;
    # Without this the wrapper injects the build platform gcc's library dirs
    # and libstdc++ headers, which are x86 ELF.
    useCcForLibs = false;
    extraBuildCommands = ''
      echo "--sysroot=${sysroot} ${toString platform.compilerFlags}" >> $out/nix-support/cc-cflags
    '';
  };
in

pkgs.stdenv.override (old: {
  inherit (pkgs.stdenv) buildPlatform;
  hostPlatform = platform.system;
  targetPlatform = platform.system;
  inherit cc;
  hasCC = true;

  # Executable-shaping linker flags belong on clang-driven links only;
  # NIX_LDFLAGS would also reach partial `ld -r` links, where flags like
  # --export-table are invalid.
  #
  # The multiple-outputs hook unconditionally prepends `-rpath $lib/lib` to
  # NIX_LDFLAGS before any platform guard can run, and wasm-ld has no rpath;
  # the wrappers only read NIX_LDFLAGS when the compiler runs, so it can
  # still be dropped here.
  preHook = (old.preHook or "") + ''
    export NIX_CFLAGS_LINK="${
      toString (map (flag: "-Wl,${flag}") platform.linkerFlags)
    } ''${NIX_CFLAGS_LINK-}"
    postHooks+=('export NIX_LDFLAGS="$(printf %s "''${NIX_LDFLAGS-}" | sed -E "s/(^| )-rpath [^ ]+//g")"')
  '';

  # The build platform's stdenv customisations do not apply to wasm packages.
  overrides = _: _: { };
  extraBuildInputs = [ ];
  extraNativeBuildInputs = [
    # Old autotools tarballs predate the wasm32 triple.
    pkgs.updateAutotoolsGnuConfigScriptsHook
  ];
  allowedRequisites = null;
})

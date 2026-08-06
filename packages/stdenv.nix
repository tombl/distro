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
    # Without these the wrapper injects the build platform gcc's library dirs,
    # libstdc++ headers, and a --gcc-toolchain flag, which are x86 ELF; the
    # flag is also an unused argument on every clang invocation, which breaks
    # ad-hoc `$CC -Werror` compiles.
    useCcForLibs = false;
    gccForLibs = null;
    extraBuildCommands = ''
      echo "--sysroot=${sysroot} ${toString platform.compilerFlags}" >> $out/nix-support/cc-cflags
    '';
  };
  # Autoconf answers for probes that lie under cross-compilation: AC_FUNC_MMAP
  # hard-codes yes for linux hosts though wasm has no mmap, and musl's static
  # dlopen stub links though dynamic loading can never work, so configures
  # enable code paths that fail at compile time or runtime. A site file states
  # the platform truth once for every port.
  configSite = pkgs.writeText "wasm-config.site" ''
    # wasm musl does not provide fork/vfork. The *_works forms are gnulib's
    # runtime-probe cache names; both spellings are platform-wide facts.
    ac_cv_func_fork=no
    ac_cv_func_vfork=no
    ac_cv_func_fork_works=no
    ac_cv_func_vfork_works=no
    ac_cv_func_mmap_fixed_mapped=no
    ac_cv_func_dlopen=no
    ac_cv_search_dlopen=no
    ac_cv_lib_dl_dlopen=no
    # wasm reports sigaltstack as ENOSYS: alternate signal stacks remain
    # unsupported, so configure probes must keep the function disabled.
    ac_cv_func_sigaltstack=no
  '';
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
    # The toolchain ships unprefixed llvm-* binutils, so the bintools wrapper
    # never exports the tool variables the way prefixed cross wrappers do;
    # plain Makefiles otherwise fall back to the build platform's `ar`.
    export AR=llvm-ar RANLIB=llvm-ranlib NM=llvm-nm
    # This target is installed by apk into an FHS root with a real /sbin. nixpkgs'
    # move-sbin hook replaces package sbin directories with `sbin -> bin`, which
    # conflicts with another APK's real sbin directory. Keep the installed FHS
    # layout and let apk track file ownership normally.
    export dontMoveSbin=1
    export CONFIG_SITE=${configSite}
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

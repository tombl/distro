# rustc built from source against the fork LLVM, with in-tree
# wasm32-unknown-linux-musl and wasm64-unknown-linux-musl targets. The source
# is the nightly dist tarball for the commit the fenix pin ships, plus the
# compiler patch series exported from github:tombl/rust wasm-linux:
#   git format-patch --no-signature --zero-commit 0e29c21d9..wasm-linux -o distro/rustc/patches
#
# wasm64 Linux's 8-byte va_arg slots wait on tombl/rust wasm64-linux-varargs,
# which only matches a caller once the LLVM pin includes the same layout
# (tombl/llvm-project#1).
#
# Only the host compiler and host std are built here. Target standard
# libraries are built with -Zbuild-std by rust-toolchain, so a musl or libc
# bump never rebuilds the compiler. The fenix nightly for the same commit is
# stage0, which bootstrap detects as a local rebuild: one compiler stage
# instead of two.
{
  lib,
  pkgs,
  llvm-toolchain-unwrapped,
  fenix ?
    import
      (pkgs.fetchFromGitHub {
        owner = "nix-community";
        repo = "fenix";
        rev = "fa09e6473a0dfd673e6cb9a37741aec513b4bb2a";
        hash = "sha256-qsmQMPL+qInjXfdjX0RquObSKcs5h/4D63IWH9j4+Ro=";
      })
      {
        inherit pkgs;
        inherit (pkgs) system;
      },
}:

let
  # The compiler that built llvm-toolchain-unwrapped; rustc_llvm's C++ shim
  # compiles against its headers and links its static libraries.
  stdenv = pkgs.llvmPackages_22.stdenv;
  host = stdenv.hostPlatform.rust.rustcTarget;

  stage0 = fenix.complete.withComponents [
    "rustc"
    "cargo"
    "rust-std"
    # Bootstrap downloads a rustfmt unless given one.
    "rustfmt"
  ];

  src = pkgs.fetchurl {
    url = "https://static.rust-lang.org/dist/2026-07-22/rustc-nightly-src.tar.xz";
    hash = "sha256-Kp8sbsyaAKwavX8XumZr+YFveS9073f5naPMjCq+pFs=";
  };

  patches = [
    ./patches/0001-Give-wasm32-wali-linux-musl-the-wali-vendor.patch
    ./patches/0002-Add-wasm32-and-wasm64-unknown-linux-musl-targets.patch
  ];

  config = (pkgs.formats.toml { }).generate "bootstrap.toml" {
    change-id = "ignore";
    llvm = {
      download-ci-llvm = false;
      link-shared = false;
    };
    build = {
      build = host;
      host = [ host ];
      target = [ host ];
      # Bootstrap passes the cargo flags of src/stage0's beta cargo; nightly
      # cargo has since renamed some (-Zno-embed-metadata).
      cargo = "${fenix.beta.cargo}/bin/cargo";
      rustc = "${stage0}/bin/rustc";
      rustfmt = "${stage0}/bin/rustfmt";
      vendor = true;
      docs = false;
      compiler-docs = false;
      extended = false;
      submodules = false;
      optimized-compiler-builtins = false;
    };
    rust = {
      channel = "nightly";
      # The compiler is linked once and never shipped outside Nix; LTO costs
      # far more memory than it saves at run time.
      lto = "off";
      debug = false;
      debuginfo-level = 0;
      lld = false;
      llvm-tools = false;
      download-rustc = false;
      deny-warnings = false;
      codegen-backends = [ "llvm" ];
    };
    target.${host} = {
      llvm-config = "${llvm-toolchain-unwrapped}/bin/llvm-config";
      cc = "${stdenv.cc}/bin/cc";
      cxx = "${stdenv.cc}/bin/c++";
      ar = "${stdenv.cc.bintools}/bin/ar";
      ranlib = "${stdenv.cc.bintools}/bin/ranlib";
      linker = "${stdenv.cc}/bin/cc";
    };
  };
in
stdenv.mkDerivation {
  pname = "rustc-wasm-linux";
  version = "1.99.0-nightly-2026-07-21";
  inherit src patches;

  nativeBuildInputs = [
    pkgs.python3
    pkgs.which
    pkgs.file
  ];

  # llvm-config --system-libs for the fork's static LLVM.
  buildInputs = [
    pkgs.libffi
    pkgs.libxml2
    pkgs.ncurses
    pkgs.zlib
  ];

  postPatch = ''
    patchShebangs src/etc x
  '';

  configurePhase = ''
    runHook preConfigure
    install -m644 ${config} bootstrap.toml
  ''
  # The stage 1 compiler runs during the build, before fixup could patch it,
  # and the linker wrapper does not record rpaths for the libraries LLVM pulls
  # in through rustc's link line.
  + lib.optionalString stdenv.hostPlatform.isLinux ''
    export NIX_LDFLAGS="$NIX_LDFLAGS -rpath ${
      lib.makeLibraryPath [
        pkgs.zlib
        pkgs.libxml2
        pkgs.stdenv.cc.cc.lib
      ]
    }"
  ''
  + ''
    runHook postConfigure
  '';

  # The compiler crates link against the whole of LLVM statically; keep the
  # number of concurrent rustc processes, each multi-threaded in codegen, low.
  buildPhase = ''
    runHook preBuild
    jobs=$(( NIX_BUILD_CORES > 4 ? 4 : NIX_BUILD_CORES ))
    python3 x.py build --stage 1 -j $jobs library
    runHook postBuild
  '';

  # The stage 1 sysroot is the finished compiler and its host std.
  installPhase = ''
    runHook preInstall
    cp -r build/${host}/stage1 $out
    # Bootstrap links the source tree into the sysroot; rust-toolchain supplies
    # library sources for -Zbuild-std itself.
    rm -rf $out/lib/rustlib/${host}/bin $out/lib/rustlib/rustc-src $out/lib/rustlib/src
    runHook postInstall
  '';

  passthru = {
    inherit stage0 src patches;
    # Nightly cargo from the same fenix pin, without stage0's bare rustc.
    inherit (fenix.complete) cargo;
  };
}

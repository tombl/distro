# The porting SDK: the stdenv's compiler, flags, and autoconf answers packaged
# for builds outside Nix. Plain `$CC hello.c`, `./configure && make`, CMake, and
# Meson produce guest binaries without the porter knowing any wasm flags, so
# platform knowledge lives here rather than in documentation.
#
# The stdenv keeps its own cc-wrapper; the SDK is built beside it so adopting
# the SDK cannot change any package's hash.
{
  pkgs,
  lib,
  callPackage,
  platform,
  llvm-toolchain,
  sysroot,
  busybox,
  vm-test,
}:

let
  triple = platform.targetTriple;
  libunwind = callPackage ./libunwind.nix { };

  # clang config files carry what the stdenv's cc-wrapper and preHook add.
  # `$`-prefixed options apply only when clang drives a link, matching the
  # stdenv's NIX_CFLAGS_LINK, so compile-only probes under -Werror never see
  # unused linker arguments.
  clangConfig = pkgs.writeText "${triple}.cfg" ''
    --target=${triple}
    --sysroot=${sysroot}
    ${toString platform.compilerFlags}
    ${lib.concatMapStringsSep "\n" (flag: "$-Wl,${flag}") platform.linkerFlags}
    # The wasm-linux driver neither adds libc++'s include directories nor
    # links libc++ (it asks for -lstdc++). -stdlib++-isystem only applies to
    # C++ compiles, so `cc -x c++` works too.
    -stdlib=libc++
    -stdlib++-isystem ${sysroot}/include/${platform.multiarchTriple}/c++/v1
    -stdlib++-isystem ${sysroot}/include/c++/v1
    # Keep store paths out of __FILE__ and debug info: binaries are destined
    # for a guest without /nix/store, and APK packaging rejects references.
    -ffile-prefix-map=${sysroot}=/usr
  '';

  clangxxConfig = pkgs.writeText "${triple}-c++.cfg" ''
    @${clangConfig}
    $-Wl,-L${libunwind}/lib
    $-lunwind
  '';

  # Configure scripts in the SDK cross-compile without flags. config.site runs
  # after option parsing, so an explicit --host still wins, but before the
  # host is canonicalised or any conftest is run on the build machine.
  configSite = pkgs.writeText "${triple}-config.site" ''
    if test -z "$host_alias"; then
      host_alias=${triple}
      ac_tool_prefix=${triple}-
    fi
    cross_compiling=yes
    # Static-only target: libtool otherwise tries to build shared libraries.
    : ''${enable_shared=no}
    . ${platform.configSite}
  '';

  wrapClang = driver: config: ''
    #!${pkgs.runtimeShell}
    exec ${llvm-toolchain}/bin/${driver} --config=${config} "$@"
  '';

  binutils = {
    ar = "llvm-ar";
    ranlib = "llvm-ranlib";
    nm = "llvm-nm";
    strip = "llvm-strip";
    objcopy = "llvm-objcopy";
    objdump = "llvm-objdump";
    readelf = "llvm-readelf";
    size = "llvm-size";
    strings = "llvm-strings";
    addr2line = "llvm-addr2line";
    "c++filt" = "llvm-cxxfilt";
    ld = "wasm-ld";
  };

  sdk =
    pkgs.runCommand "wasm-sdk"
      {
        passthru = {
          inherit libunwind;

          devShell = pkgs.mkShellNoCC {
            packages = [
              sdk
              pkgs.autoconf
              pkgs.automake
              pkgs.libtool
              pkgs.cmake
              pkgs.ninja
              pkgs.meson
            ];
          };

          checks = {
            run = vm-test.installedTest {
              name = "sdk-run";
              init = ./tests/run-test.sh;
              contents = [
                busybox
                sdk.checks.build
              ];
            };

            # The devshell's own inputs, so the check sees what porters see.
            build = pkgs.stdenvNoCC.mkDerivation {
              name = "sdk-build-test";
              nativeBuildInputs = sdk.devShell.nativeBuildInputs;
              buildCommand = ''
                cp -r ${./tests} tests
                chmod -R u+w tests
                cd tests
                mkdir -p $out/usr/bin

                $CC hello.c -o $out/usr/bin/hello-c
                $CXX hello.cc -o $out/usr/bin/hello-cxx

                cmake -S . -B cmake-build -G Ninja
                cmake --build cmake-build
                cp cmake-build/hello-cmake cmake-build/hello-cmake-cxx $out/usr/bin/

                meson setup meson-build --cross-file ${triple}
                meson compile -C meson-build
                cp meson-build/hello-meson meson-build/hello-meson-cxx $out/usr/bin/

                # A release tarball as porters meet it, built both with no
                # flags and with the conventional --host. Only the debug info's
                # build directory may differ between the two.
                tar xf ${pkgs.hello.src}
                mkdir plain host
                (cd plain && ../hello-*/configure && make)
                (cd host && ../hello-*/configure --host=${triple} && make)
                $STRIP --strip-debug plain/hello host/hello
                cmp plain/hello host/hello
                cp plain/hello $out/usr/bin/hello
              '';
            };
          };
        };
      }
      ''
        mkdir -p $out/bin $out/share/cmake $out/share/meson/cross $out/nix-support

        cat > $out/bin/${triple}-cc <<'EOF'
        ${wrapClang "clang" clangConfig}
        EOF
        cat > $out/bin/${triple}-c++ <<'EOF'
        ${wrapClang "clang++" clangxxConfig}
        EOF
        chmod +x $out/bin/*
        ln -s ${triple}-cc $out/bin/${triple}-clang
        ln -s ${triple}-c++ $out/bin/${triple}-clang++

        ${lib.concatStrings (
          lib.mapAttrsToList (name: tool: ''
            ln -s ${llvm-toolchain}/bin/${tool} $out/bin/${triple}-${name}
          '') binutils
        )}

        # pkg-config must never fall back to the build machine's .pc files;
        # porters point PKG_CONFIG_PATH at their own guest dependencies.
        cat > $out/bin/${triple}-pkg-config <<'EOF'
        #!${pkgs.runtimeShell}
        export PKG_CONFIG_LIBDIR="''${PKG_CONFIG_LIBDIR-}"
        exec ${pkgs.pkg-config.pkg-config}/bin/pkg-config "$@"
        EOF
        chmod +x $out/bin/${triple}-pkg-config

        cp ${configSite} $out/share/config.site

        cat > $out/share/cmake/${triple}.cmake <<EOF
        set(CMAKE_SYSTEM_NAME Linux)
        set(CMAKE_SYSTEM_PROCESSOR wasm32)
        set(CMAKE_SYSROOT ${sysroot})
        set(CMAKE_C_COMPILER $out/bin/${triple}-cc)
        set(CMAKE_CXX_COMPILER $out/bin/${triple}-c++)
        set(CMAKE_AR $out/bin/${triple}-ar)
        set(CMAKE_RANLIB $out/bin/${triple}-ranlib)
        set(CMAKE_STRIP $out/bin/${triple}-strip)
        set(PKG_CONFIG_EXECUTABLE $out/bin/${triple}-pkg-config)
        set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
        set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
        set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
        set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
        set(BUILD_SHARED_LIBS OFF CACHE BOOL "")
        EOF

        # Found by name: `meson setup --cross-file ${triple}` searches
        # XDG_DATA_DIRS, which the setup hook extends.
        cat > $out/share/meson/cross/${triple} <<EOF
        [binaries]
        c = '$out/bin/${triple}-cc'
        cpp = '$out/bin/${triple}-c++'
        ar = '$out/bin/${triple}-ar'
        strip = '$out/bin/${triple}-strip'
        pkg-config = '$out/bin/${triple}-pkg-config'

        [built-in options]
        default_library = 'static'
        b_staticpic = false

        [properties]
        needs_exe_wrapper = true

        [host_machine]
        system = 'linux'
        cpu_family = 'wasm32'
        cpu = 'wasm32'
        endian = 'little'
        EOF

        cat > $out/nix-support/setup-hook <<EOF
        export CC=${triple}-cc CXX=${triple}-c++ LD=${triple}-ld
        export AR=${triple}-ar RANLIB=${triple}-ranlib NM=${triple}-nm
        export STRIP=${triple}-strip OBJCOPY=${triple}-objcopy
        export OBJDUMP=${triple}-objdump READELF=${triple}-readelf
        export PKG_CONFIG=${triple}-pkg-config
        # Generators which run during the build need the build machine's
        # toolchain; autoconf macros and Meson look for these names.
        export CC_FOR_BUILD=${pkgs.stdenv.cc}/bin/cc
        export CXX_FOR_BUILD=${pkgs.stdenv.cc}/bin/c++
        export AR_FOR_BUILD=${pkgs.stdenv.cc.bintools}/bin/ar
        export CONFIG_SITE=$out/share/config.site
        export CMAKE_TOOLCHAIN_FILE=$out/share/cmake/${triple}.cmake
        addToSearchPath XDG_DATA_DIRS $out/share
        EOF
      '';
in
sdk

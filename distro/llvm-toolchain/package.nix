# The build-platform toolchain with the wasm runtimes in clang's resource
# directory. This is what gets cc-wrapped into the scope's stdenv, and what the
# devshell exposes for compiling wasm by hand. Its target is always wasm, so
# `ld` is wasm-ld.
{
  pkgs,
  lib,
  platform,
  llvm-runtimes,
  llvm-toolchain-unwrapped,
}:

let
  inherit (llvm-toolchain-unwrapped) version;
  llvmMajorVersion = lib.versions.major version;
in

pkgs.runCommand "llvm-toolchain-${version}"
  {
    passthru = {
      isClang = true;
      hardeningUnsupportedFlags = [
        "bindnow"
        "fortify"
        "fortify3"
        "pic"
        "pie"
        "relro"
        "shadowstack"
        "stackclashprotection"
        "stackprotector"
        "strictoverflow"
        "trivialautovarinit"
        "zerocallusedregs"
      ];
    };
  }
  ''
    unwrapped=${llvm-toolchain-unwrapped}
    resources=lib/clang/${llvmMajorVersion}

    # Clang locates its resource directory from its real executable, so that
    # one file is copied; everything else links into the unwrapped toolchain
    # instead of duplicating its 2.5 GB.
    mkdir -p $out/bin $out/$resources/lib
    clang=$(readlink -f $unwrapped/bin/clang)
    cp $clang $out/bin/
    for path in $unwrapped/bin/*; do
      name=$(basename $path)
      if [ -e $out/bin/$name ]; then
        continue
      elif [ "$(readlink -f $path)" = "$clang" ]; then
        ln -s $(basename $clang) $out/bin/$name
      else
        ln -s $path $out/bin/$name
      fi
    done
    for path in $unwrapped/*; do
      case $(basename $path) in
        bin | lib) ;;
        *) ln -s $path $out/ ;;
      esac
    done
    for path in $unwrapped/lib/*; do
      [ $(basename $path) = clang ] || ln -s $path $out/lib/
    done
    ln -s $unwrapped/$resources/include $out/$resources/include

    cp -r ${llvm-runtimes}/$resources/lib/${platform.targetTriple} $out/$resources/lib/
    cp -r ${llvm-runtimes}/$resources/lib/wasm32 $out/$resources/lib/
    cp -r ${llvm-runtimes}/$resources/lib/wasm32-unknown $out/$resources/lib/

    ln -sf wasm-ld $out/bin/ld
  ''

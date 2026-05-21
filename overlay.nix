{ inputs }:

_final: prev:

{
  wasmpkgs = prev.lib.makeScope prev.newScope (self: {
    platform = import ./packages/platform.nix { inherit (prev) lib; };

    # toolchain:
    llvm-runtimes-wasm = self.callPackage ./packages/llvm-runtimes-wasm {
      src = inputs.llvm-src.outPath;
    };
    llvm-toolchain = self.callPackage ./packages/llvm-toolchain {
      src = inputs.llvm-src.outPath;
    };
    llvm-toolchain-host = self.callPackage ./packages/llvm-toolchain-host { };
    llvm-toolchain-host-unwrapped = self.callPackage ./packages/llvm-toolchain-host-unwrapped {
      src = inputs.llvm-src.outPath;
    };
    musl = self.callPackage ./packages/musl { src = inputs.musl-src.outPath; };
    sysroot = self.callPackage ./packages/sysroot { };
    sysroot-base = self.callPackage ./packages/sysroot-base { };

    # userland:
    busybox = self.callPackage ./packages/busybox { src = inputs.busybox-src.outPath; };
    sqlite3 = self.callPackage ./packages/sqlite3 { src = inputs.sqlite-src.outPath; };

    # os:
    basic-init = self.callPackage ./packages/basic-init { };
    initramfs = self.callPackage ./packages/initramfs { };
    linux = self.callPackage ./packages/linux { src = inputs.linux-src.outPath; };
    mkRootfs = self.callPackage ./packages/rootfs-builder { };
    rootfs = self.callPackage ./packages/rootfs { };

    # tools:
    runner = self.callPackage ./packages/runner { };
    site = self.callPackage ./packages/site { };
  });
}

- split these into separate packages:
  - the kernel
  - the js host library
  - the deno runner
  - the web ui
- musl
  - patch/wrap/configure clang to include libc.a and crt1.o
- busybox
- generate initramfs
- generate bundle of kernel+lib+ui+initramfs
- make
- gnu coreutils
- util-linux
- bash
- cmake
- cpio
- ninja
- llvm/clang/wasm-ld
- go
- esbuild
- kernel
  - perl, bc, bison, flex
- cpython
- meson
- apk-tools
  - distribute nix built packages as apk packages
- pkg-config, glib
- ncurses

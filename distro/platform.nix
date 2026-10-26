{ lib }:

rec {
  targetTriple = "wasm32-unknown-linux-musl";
  multiarchTriple = "wasm32-linux-musl";
  apkArch = "wasm32";

  # The elaborated nixpkgs platform used as the stdenv's host platform. The
  # kernel is Linux but the executable format is not ELF; getting that right
  # makes nixpkgs skip its ELF machinery (rpaths, patchelf, strip-by-default).
  # elaborate always derives `parsed` from `config`, so the format is
  # corrected after the fact.
  system =
    lib.recursiveUpdate
      (lib.systems.elaborate {
        config = targetTriple;
        isStatic = true;
        hasSharedLibraries = false;
      })
      {
        parsed.kernel.execFormat = lib.systems.parse.execFormats.wasm;
        isElf = false;
      };

  # Every wasm compilation needs these; the cc-wrapper bakes them in.
  compilerFlags = [
    "-matomics"
    "-mbulk-memory"
    # LLVM must lower setjmp/longjmp in every translation unit containing a
    # call site; libc cannot add this transformation at link time.
    "-mllvm"
    "-wasm-enable-sjlj"
    # C++ is compiled with exceptions, as on every Linux target. This selects
    # wasm exception handling, which sjlj already uses, instead of compiling
    # `throw` but discarding every catch. C has no landing pads unless it opts
    # in with -fexceptions. Spelled as the backend option rather than
    # -fwasm-exceptions, which assembler-only invocations report as unused.
    "-mllvm"
    "-wasm-enable-eh"
    # The legacy EH encoding, chosen over exnref in "Userspace" in
    # docs/architecture.md. Spelled out so an LLVM default flip can't change it.
    "-mllvm"
    "-wasm-use-legacy-eh"
  ];

  # Default declared maximum of a process's shared memory, in bytes. WebKit
  # reserves a shared memory's full maximum up front from a fixed per-tab
  # budget (64 GiB, 16 GiB on iOS), so this bounds how many processes can be
  # live at once. The maximum cannot be raised after creation: growth past it
  # fails as ENOMEM. Packages whose programs need more set `maxMemory`
  # (a multiple of 64 KiB) on the derivation. RLIMIT_AS still lowers it at
  # exec.
  defaultMaxMemory = 256 * 1024 * 1024;

  # Flags for linking wasm executables the kernel can load. No --fatal-warnings
  # here: wasm-ld warns on the wrong-prototype probes autoconf-style configure
  # scripts link, and promoting that to an error breaks every such probe.
  linkerFlags = [
    "--import-memory"
    "--max-memory=${toString defaultMaxMemory}"
    "--shared-memory"
    "--export-table"
    # clang's wasm-linux toolchain defaults the table base to 3, reserving
    # function-pointer values 1 and 2 for SIG_IGN and SIG_HOLD.
    # wasm-ld's default shadow stack is 64 KiB, which terminal setup in
    # ncurses/readline overflows; match the 8 MiB Linux convention.
    "-z"
    "stack-size=8388608"
  ];

  # Autoconf answers for probes that lie under cross-compilation: AC_FUNC_MMAP
  # hard-codes yes for linux hosts though wasm has no mmap, and musl's static
  # dlopen stub links though dynamic loading can never work, so configures
  # enable code paths that fail at compile time or runtime. A site file states
  # the platform truth once for every port, whether built by the stdenv or the
  # SDK.
  configSite = ./config.site;
}

{ lib }:

rec {
  targetTriple = "wasm32-unknown-linux-musl";
  multiarchTriple = "wasm32-linux-musl";

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
  ];

  # Flags for linking wasm executables the kernel can load. No --fatal-warnings
  # here: wasm-ld warns on the wrong-prototype probes autoconf-style configure
  # scripts link, and promoting that to an error breaks every such probe.
  linkerFlags = [
    "--import-memory"
    "--max-memory=4294967296"
    "--shared-memory"
    "--export-table"
    # Linux's signal ABI reserves function-pointer value 1 for SIG_IGN, and
    # musl's public signal API uses value 2 for SIG_HOLD. Wasm function pointers
    # are table indices, so leave those slots empty rather than letting real
    # address-taken functions collide with the signal sentinels.
    "--table-base=3"
    # wasm-ld's default shadow stack is 64 KiB, which terminal setup in
    # ncurses/readline overflows; match the 8 MiB Linux convention.
    "-z"
    "stack-size=8388608"
  ];
}

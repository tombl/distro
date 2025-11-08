{
  run,
  config,
  lib,

  clang,
  lld,
  sysroot,
}:

run
  {
    name = "basic-init";
    src = ./.;
    path = [
      clang
      lld
    ];
  }
  ''
    clang -c -o init.o init.c --target=wasm32-unknown-linux-musl --sysroot=${sysroot} ${lib.optionalString config.debug "-g"} -matomics -mbulk-memory
    clang -o init init.o --target=wasm32-unknown-linux-musl --sysroot=${sysroot} -Wl,--fatal-warnings,--import-memory,--max-memory=4294967296,--shared-memory,--export-table

    mkdir -p $out/bin
    cp init $out/bin
  ''

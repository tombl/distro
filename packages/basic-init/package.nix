{
  run,
  config,
  lib,

  clang,
  lld,
  musl,
  compiler-rt,
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
    clang -c -o init.o init.c --target=wasm32-linux -nostdinc -isystem ${musl}/include ${lib.optionalString config.debug "-g"} -matomics -mbulk-memory
    wasm-ld -o init init.o ${compiler-rt}/libclang_rt.builtins-wasm32.a ${musl}/lib/crt1.o -L${musl}/lib -lc --fatal-warnings --import-memory --max-memory=4294967296 --shared-memory --export-table

    mkdir -p $out/bin
    cp init $out/bin
  ''

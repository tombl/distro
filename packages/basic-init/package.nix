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
    clang -c -o init.o init.c --target=wasm32 -nostdinc -isystem ${musl}/include ${lib.optionalString config.debug "-g"}
    wasm-ld -o init init.o ${compiler-rt}/libclang_rt.builtins-wasm32.a ${musl}/lib/crt1.o -L${musl}/lib -lc --fatal-warnings --initial-memory=655360

    mkdir -p $out/bin
    cp init $out/bin
  ''

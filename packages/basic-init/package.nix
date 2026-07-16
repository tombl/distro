{
  run,
  config,
  lib,
  vm-test,

  clang,
  lld,
  sysroot,
}:

let
  buildInit =
    name: source:
    run
      {
        inherit name;
        src = ./.;
        path = [
          clang
          lld
        ];
      }
      ''
        clang -c -o init.o ${source} \
          --target=wasm32-unknown-linux-musl \
          --sysroot=${sysroot} \
          ${lib.optionalString config.debug "-g"} \
          -matomics -mbulk-memory
        clang -o init init.o \
          --target=wasm32-unknown-linux-musl \
          --sysroot=${sysroot} \
          -Wl,--fatal-warnings,--import-memory,--max-memory=4294967296,--shared-memory,--export-table

        mkdir -p $out/bin
        cp init $out/bin/init
      '';

  package = buildInit "basic-init" "init.c";

  check =
    name:
    let
      init = buildInit "basic-init-${name}" "tests/${name}.c";
      initramfs = vm-test.mkInitramfs {
        name = "basic-init-${name}";
        init = "${init}/bin/init";
      };
    in
    vm-test.vmTest {
      name = "basic-init-${name}";
      inherit initramfs;
    };
in
package
// {
  checks = {
    boot = check "boot";
    clone = check "clone";
    clone-return = check "clone-return";
    cwd = check "cwd";
    proc-self-mem = check "proc-self-mem";
  };
}

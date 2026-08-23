# Lowest-fidelity Zig bootstrap: use an unmodified upstream compiler, avoid
# Zig's target standard library, and hand the distro crt/libc to Zig's linker.
{
  pkgs,
  sysroot,
  busybox,
  vm-test,
}:

let
  zig-bootstrap-smoke =
    pkgs.runCommand "zig-bootstrap-smoke"
      {
        nativeBuildInputs = [ pkgs.zig_0_16 ];
      }
      ''
        export ZIG_GLOBAL_CACHE_DIR=$TMPDIR/zig-global-cache
        export ZIG_LOCAL_CACHE_DIR=$TMPDIR/zig-local-cache

        zig build-exe ${./hello.zig} \
          -target wasm32-linux-musl \
          -mcpu=baseline+atomics+bulk_memory+mutable_globals+sign_ext \
          -OReleaseSmall \
          --import-memory \
          --max-memory=4294967296 \
          --shared-memory \
          --export-table \
          --stack 8388608 \
          -fno-compiler-rt \
          ${sysroot}/lib/crt1.o \
          ${sysroot}/lib/libc.a \
          ${sysroot}/lib/libclang_rt.builtins.a \
          -femit-bin=zig-bootstrap-smoke

        install -Dm755 zig-bootstrap-smoke $out/bin/zig-bootstrap-smoke
      '';
in
zig-bootstrap-smoke.overrideAttrs (old: {
  passthru = (old.passthru or { }) // {
    checks.vm = vm-test.installedTest {
      name = "zig-bootstrap-smoke";
      init = ./init.sh;
      contents = [
        busybox
        zig-bootstrap-smoke
      ];
    };
  };
})

# The canary for the Rust toolchain: std on wasm32-unknown-linux-musl,
# exercising the surface most likely to break with an ABI mistake in the libc
# port. Threads cover clone/futex/TLS, the mutex counter catches lost atomics,
# and the sleep/park_timeout assertions catch time64 timespec mismatches,
# which corrupt timeouts silently rather than failing loudly.
{
  rust-toolchain,
  busybox,
  vm-test,
}:

let
  rust-smoke = rust-toolchain.buildRustPackage {
    pname = "rust-smoke";
    version = "0.0.0";
    src = ./.;
    cargoLock.lockFile = ./Cargo.lock;
    apk = { };

    passthru.checks.threads = vm-test.installedTest {
      name = "rust-smoke-threads";
      cpus = 2;
      init = ./threads-test.sh;
      contents = [
        busybox
        rust-smoke
      ];
    };
  };
in
rust-smoke

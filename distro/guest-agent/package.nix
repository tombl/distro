{
  stdenv,
  pkgs,
}:

let
  package = stdenv.mkDerivation {
    pname = "linux-guest-agent";
    version = "0.0.0";
    src = ./.;

    buildPhase = ''
      runHook preBuild
      $CC -Wall -Wextra -Werror -Wno-error=unused-command-line-argument \
        -Wl,--fatal-warnings -o linux-guest-agent agent.c
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out/bin
      cp linux-guest-agent $out/bin/linux-guest-agent
      runHook postInstall
    '';
  };

  # The host library's abi.ts is the single source of truth for guest ABI
  # facts (syscall numbers, struct layouts). This check compiles — never
  # runs — a generated file of _Static_asserts with the guest toolchain, so
  # any drift between abi.ts and the real headers is a build failure.
  abi = stdenv.mkDerivation {
    pname = "linux-guest-agent-abi-check";
    version = "0.0.0";
    src = ./.;
    nativeBuildInputs = [ pkgs.nodejs_26 ];

    buildPhase = ''
      runHook preBuild
      # abi.ts imports the bytes helpers beside it in the package source.
      mkdir -p src/guest src/bytes
      cp ${../../packages/lowland/src/guest/abi.ts} src/guest/abi.ts
      cp ${../../packages/lowland/src/bytes/index.ts} src/bytes/index.ts
      echo '{"type":"module"}' > package.json
      node gen-abi-check.ts ./src/guest/abi.ts > abi-check.c
      $CC -Wall -Wextra -Werror -Wno-error=unused-command-line-argument \
        -c abi-check.c -o abi-check.o
      runHook postBuild
    '';

    installPhase = "touch $out";
  };
in
package
// {
  checks.abi = abi;
}

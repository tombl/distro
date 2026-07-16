{ stdenv }:

stdenv.mkDerivation {
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
}

{ pkgs, formatter }:

pkgs.mkShellNoCC {
  packages = [
    pkgs.wasmpkgs.llvm-toolchain-host
    pkgs.cmake
    pkgs.deno
    pkgs.nodejs
    (pkgs.writeShellScriptBin "hostcc" ''exec ${pkgs.wasmpkgs.llvm-toolchain-host}/bin/clang "$@"'')
    formatter
  ];
  env = {
    inherit (pkgs.wasmpkgs) sysroot;
  };
}

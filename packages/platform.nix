{ lib }:

{
  targetTriple = "wasm32-unknown-linux-musl";

  system = lib.systems.elaborate {
    system = "wasm32-linux";
    config = "wasm32-unknown-linux-musl";
    parsed = {
      cpu = {
        name = "wasm32";
        bits = 32;
        endian = "little";
        family = "wasm";
        significantByte = lib.systems.parse.significantBytes.littleEndian;
      };
      vendor.name = "unknown";
      kernel = {
        name = "linux";
        execFormat = lib.systems.parse.execFormats.unknown;
      };
      abi.name = "musl";
    };
    isStatic = true;
    isNoMMU = true;
    hasFork = false;
    hasMmap = false;
    hasDlopen = false;
    hasDynamicLinking = false;
  };

  userlandCFlags = [
    "-matomics"
    "-mbulk-memory"
  ];

  linkerFlags = [
    "--fatal-warnings"
    "--import-memory"
    "--max-memory=4294967296"
    "--shared-memory"
    "--export-table"
  ];
}

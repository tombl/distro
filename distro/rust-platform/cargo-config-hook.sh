# shellcheck shell=bash

lowlandCargoConfigHook() {
  mkdir -p .cargo
  # Cargo projects are not required to terminate an existing config with a
  # newline. Always separate it from the platform tables appended below.
  printf '\n' >>.cargo/config.toml
  cat @nixCargoConfig@ >>.cargo/config.toml
}

postPatchHooks+=(lowlandCargoConfigHook)

# shellcheck shell=bash

# shellcheck disable=SC2034
readonly \
  zigDefaultCpuFlag=@zig_default_cpu_flag@ \
  zigDefaultOptimizeFlag=@zig_default_optimize_flag@ \
  zigDefaultTargetFlag=@zig_default_target_flag@

zigConfigurePhase() {
  runHook preConfigure

  ZIG_GLOBAL_CACHE_DIR=$(mktemp -d)
  export ZIG_GLOBAL_CACHE_DIR

  runHook postConfigure
}

zigFlags() {
  local destination=$1
  shift

  local buildCores=1
  if [ "${enableParallelBuilding-1}" ]; then
    buildCores="$NIX_BUILD_CORES"
  fi

  eval "$destination+=(\"-j$buildCores\")"
  concatTo "$destination" "$@"
  if [ -z "${dontSetZigDefaultFlags:-}" ]; then
    concatTo "$destination" \
      zigDefaultTargetFlag zigDefaultCpuFlag zigDefaultOptimizeFlag
  fi
}

zigBuildPhase() {
  runHook preBuild

  local flagsArray=()
  zigFlags flagsArray zigBuildFlags zigBuildFlagsArray
  echoCmd 'zig build flags' "${flagsArray[@]}"
  TERM=dumb zig build "${flagsArray[@]}" --verbose

  runHook postBuild
}

zigCheckPhase() {
  runHook preCheck

  local flagsArray=()
  zigFlags flagsArray zigCheckFlags zigCheckFlagsArray
  echoCmd 'zig check flags' "${flagsArray[@]}"
  TERM=dumb zig build test "${flagsArray[@]}" --verbose

  runHook postCheck
}

zigInstallPhase() {
  runHook preInstall

  local flagsArray=()
  zigFlags flagsArray \
    zigBuildFlags zigBuildFlagsArray zigInstallFlags zigInstallFlagsArray
  if [ -z "${dontAddPrefix-}" ] && [ -n "$prefix" ]; then
    flagsArray+=("${prefixKey:---prefix}" "$prefix")
  fi

  echoCmd 'zig install flags' "${flagsArray[@]}"
  TERM=dumb zig build install "${flagsArray[@]}" --verbose

  runHook postInstall
}

if [ -z "${dontUseZigConfigure-}" ] && [ -z "${configurePhase-}" ]; then
  configurePhase=zigConfigurePhase
fi
if [ -z "${dontUseZigBuild-}" ] && [ -z "${buildPhase-}" ]; then
  buildPhase=zigBuildPhase
fi
if [ -z "${dontUseZigCheck-}" ] && [ -z "${checkPhase-}" ]; then
  checkPhase=zigCheckPhase
fi
if [ -z "${dontUseZigInstall-}" ] && [ -z "${installPhase-}" ]; then
  installPhase=zigInstallPhase
fi

{
  bytes,
  kernel,
  linux-guest,
  node-workspace,
  pkgs,
}:

# `pnpm check` from the repository root: every workspace package's own check
# plus scripts/, each file under the tsconfig for the environment it runs in.
# The built workspace packages stand in for `pnpm --recursive build`.
pkgs.stdenvNoCC.mkDerivation {
  name = "typecheck";
  src = node-workspace.source [
    "apps/site"
    "distro/guest-agent/gen-abi-check.ts"
    "distro/vm-test"
    "packages"
    "scripts"
    "tsconfig.base.json"
    "tsconfig.node.json"
    "tsconfig.page.json"
    "tsconfig.spec.json"
    "tsconfig.worker.json"
  ];
  env.CI = "true";
  pnpmDeps = node-workspace.deps;
  nativeBuildInputs = [
    pkgs.nodejs_26
    pkgs.pnpmConfigHook
    node-workspace.pnpm
  ];

  buildPhase = ''
    runHook preBuild

    ${node-workspace.installBuilt {
      inherit bytes kernel;
      linux-guest = linux-guest.package;
    }}
    pnpm check

    runHook postBuild
  '';

  installPhase = ''
    touch $out
  '';
}

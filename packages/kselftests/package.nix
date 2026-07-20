{
  pkgs,
  lib,
  stdenv,
  src,
  linux,
  busybox,
  vm-test,
}:

# The kselftest syscall suites, built against the same kernel source the running
# kernel comes from. Each suite is a self-contained pair under suites/: a
# <name>.nix descriptor and a <name>-test.sh guest script. A suite is anything
# with a .nix here, discovered by readDir, so adding one means dropping two files
# in suites/ (and git add-ing them so the flake sees them) — no registration
# line to edit and collide on. Shared logic — the wasm build recipe, the patches
# applied once to the selftests tree, and the VM check wiring — lives here so the
# suite files stay pure data.
#
# clone3/raw-clone tests are skipped on principle across every suite: the wasm
# clone syscall takes a custom fn/fn_arg ABI, not the generic stack-based one, so
# the generic clone path does not apply. Tests going through musl's clone()
# wrapper (which speaks the wasm ABI) are run deliberately.

let
  suffixed =
    dir: suffix:
    map (name: dir + "/${name}") (
      lib.filter (lib.hasSuffix suffix) (builtins.attrNames (builtins.readDir dir))
    );

  suites = lib.listToAttrs (
    map (path: lib.nameValuePair (lib.removeSuffix ".nix" (baseNameOf path)) (import path)) (
      suffixed ./suites ".nix"
    )
  );

  # Patches are shared because suites share headers (kselftest.h, futex logging)
  # and each patch touches a disjoint file, so the apply order does not matter.
  patches = suffixed ./patches ".patch";

  # A discovered suite is real test coverage, not a boot-only placeholder.
  checkedSuites = lib.mapAttrs (
    name: suite:
    assert lib.assertMsg (suite.binaries != [ ]) "kselftest suite ${name} has no binaries";
    suite
  ) suites;
in
stdenv.mkDerivation (finalAttrs: {
  pname = "kselftests";
  inherit (linux) version;
  inherit src patches;

  # lib.mk force-sets CC from LLVM/CROSS_COMPILE, but a make command-line
  # assignment wins; passing the wasm cc-wrapper as CC sidesteps lib.mk's missing
  # CLANG_TARGET_FLAGS_wasm entry entirely. This kernel's installed uapi headers
  # go in through two doors: KHDR_INCLUDES for the suites whose Makefiles wire it,
  # and USERCFLAGS (lib.mk's documented CFLAGS extension) so suites that don't
  # (e.g. openat2) still find linux/*.h. lib.mk's own default of
  # -isystem $(top_srcdir)/usr/include points at a dir nothing populates here.
  buildPhase = ''
    runHook preBuild
    ${lib.concatStrings (
      lib.mapAttrsToList (_name: suite: ''
        make -C ${suite.dir} \
          OUTPUT=. \
          CC="$CC" \
          KHDR_INCLUDES="-isystem ${linux.headers}/include" \
          USERCFLAGS="-isystem ${linux.headers}/include" \
          ${toString (suite.makeFlags or [ ])} \
          ${lib.concatMapStringsSep " " (binary: "./${binary}") suite.binaries}
      '') checkedSuites
    )}
    runHook postBuild
  '';

  # Binaries are namespaced per suite because names collide across the tree
  # (every suite has its own test binary, some share helper names).
  installPhase = ''
    runHook preInstall
    ${lib.concatStrings (
      lib.mapAttrsToList (name: suite: ''
        mkdir -p $out/${name}
        ${lib.concatMapStrings (b: "cp ${suite.dir}/${b} $out/${name}/\n") suite.binaries}
      '') checkedSuites
    )}
    runHook postInstall
  '';

  passthru.checks = lib.mapAttrs (
    name: suite:
    let
      # Explicit per-binary copies avoid accidentally adding helper binaries to
      # the guest image when a suite's Makefile grows new targets upstream.
      suiteBin = pkgs.runCommand "kselftests-${name}-bin" { } ''
        mkdir -p $out/bin
        ${lib.concatMapStrings (b: "cp ${finalAttrs.finalPackage}/${name}/${b} $out/bin/\n") suite.binaries}
      '';
    in
    vm-test.vmTest {
      name = "kselftests-${name}";
      timeout = suite.timeout or 20;
      initramfs = vm-test.mkInitramfs {
        name = "kselftests-${name}";
        init = suite.run;
        contents = [
          busybox
          suiteBin
        ];
      };
    }
  ) checkedSuites;
})

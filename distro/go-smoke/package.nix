# The Go port's own integration suite, built through our nixpkgs-native module
# builder and booted as PID 1. It covers the runtime surface most likely to
# regress across compiler, kernel, and process-ABI changes.
{
  buildGoModule,
  go-toolchain,
  vm-test,
}:

let
  go-smoke = buildGoModule {
    pname = "go-smoke";
    version = "0.0.0";
    src = go-toolchain.src + "/misc/wasm/linux";
    vendorHash = null;

    postPatch = ''
      install -m644 ${./go.mod} go.mod
    '';

    buildPhase = ''
      runHook preBuild
      go test -c -ldflags=-buildid= -o init .
      go build -ldflags=-buildid= -o child ./testdata/child.go
      go build -ldflags=-buildid= -o grandchild ./testdata/grandchild.go
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out/bin
      install -m755 init child grandchild $out/bin/
      runHook postInstall
    '';

    passthru.checks.integration = vm-test.installedTest {
      name = "go-integration";
      cpus = 2;
      init = "${go-smoke}/bin/init";
      contents = [ go-smoke ];
      files = {
        "/child" = "${go-smoke}/bin/child";
        "/grandchild" = "${go-smoke}/bin/grandchild";
      };
    };
  };
in
go-smoke

{
  pkgs,
  sysroot,
}:

let
  target = "wasm32-linux-musl";
  cpu = "baseline+atomics+bulk_memory+mutable_globals+sign_ext";

  unwrapped = pkgs.zig_0_16.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [
      ./compiler-patches/0001-add-distro-wasm-linux-target.patch
      ./compiler-patches/0002-link-external-libc-for-wasm.patch
    ];
  });

  libcFile = pkgs.writeText "wasm32-linux-musl.libc" ''
    include_dir=${sysroot}/include
    sys_include_dir=${sysroot}/include
    crt_dir=${sysroot}/lib
    msvc_lib_dir=
    kernel32_lib_dir=
    gcc_dir=
  '';

  zigLib = pkgs.runCommand "zig-lib-wasm32-linux-${unwrapped.version}" { } ''
    cp -r ${unwrapped}/lib/zig $out
    chmod -R u+w $out

    patch -p1 -d $out < ${./patches/0001-std-add-wasm32-linux-basics.patch}
    patch -p1 -d $out < ${./patches/0002-build-apply-distro-target-defaults.patch}
    patch -p1 -d $out < ${./patches/0003-io-disable-mmu-and-fork-operations.patch}
    patch -p1 -d $out < ${./patches/0004-spawn-with-callback-clone.patch}
    patch -p1 -d $out < ${./patches/0006-enable-wasm-threads-runtime.patch}
    patch -p1 -d $out < ${./patches/0007-pass-environment-to-wasm-main.patch}
    patch -p1 -d $out < ${./patches/0008-disable-wasm-signal-backtraces.patch}
    patch -p1 -d $out < ${./patches/0009-skip-elf-auxv-startup-on-wasm.patch}
    patch -p1 -d $out < ${./patches/0010-disable-wasm-signal-stack.patch}
    install -m644 ${./wasm32.zig} $out/std/os/linux/wasm32.zig
    mkdir -p $out/libc
    install -m644 ${libcFile} $out/libc/wasm32-linux-musl.conf
  '';

  zigPackage = pkgs.runCommand "zig-wasm32-linux-${unwrapped.version}" { } ''
    mkdir -p $out/bin $out/lib
    cp ${unwrapped}/bin/zig $out/bin/zig
    ln -s ${zigLib} $out/lib/zig
  '';

  zig = zigPackage.overrideAttrs {
    pname = "zig";
    inherit (unwrapped) version;
    inherit (unwrapped) meta;
    passthru = {
      inherit
        hook
        unwrapped
        libcFile
        zigLib
        target
        cpu
        ;
    };
  };

  # Match nixpkgs' `zig.hook` interface so ordinary Zig packages only need to
  # replace their native build input. The target flag is an intentional extra:
  # this package is a distro SDK rather than a general-purpose Zig compiler.
  hook = pkgs.makeSetupHook {
    name = "zig-wasm32-linux-hook";
    propagatedBuildInputs = [ zig ];
    substitutions = {
      zig_default_cpu_flag = "-Dcpu=${cpu}";
      zig_default_optimize_flag = "--release=safe";
      zig_default_target_flag = "-Dtarget=${target}";
    };
    passthru = { inherit zig; };
  } ./setup-hook.sh;
in
{
  inherit
    unwrapped
    libcFile
    zigLib
    zig
    hook
    ;

  inherit target cpu;
  linkerFlags = [
    "--import-memory"
    "--max-memory=4294967296"
    "--shared-memory"
    "--export-table"
    "--stack"
    "8388608"
  ];

  package = zig;
}

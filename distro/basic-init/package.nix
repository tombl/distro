{
  pkgs,
  stdenv,
  vm-test,
}:

let
  buildInitWith =
    name: source: extraFlags:
    stdenv.mkDerivation {
      pname = name;
      version = "0.0.0";
      src = ./.;

      buildPhase = ''
        runHook preBuild
        $CC ${extraFlags} -Wl,--fatal-warnings -o init ${source}
        runHook postBuild
      '';

      installPhase = ''
        runHook preInstall
        mkdir -p $out/bin
        cp init $out/bin/init
        runHook postInstall
      '';
    };

  buildInit = name: source: buildInitWith name source "";

  installedCheck =
    {
      name,
      source ? "tests/${name}.c",
      extraFlags ? "",
      contents ? [ ],
      cpus ? 1,
      heavy ? false,
    }:
    let
      initPackage = buildInitWith "basic-init-${name}" source extraFlags;
    in
    vm-test.installedTest {
      name = "basic-init-${name}";
      init = "${initPackage}/bin/init";
      contents = [ initPackage ] ++ contents;
      inherit cpus heavy;
    };

  schedulerHandoffPackage = buildInit "basic-init-scheduler-handoff" "tests/scheduler-handoff.c";
  schedulerHandoffDisk = vm-test.installedDisk {
    name = "basic-init-scheduler-handoff";
    init = "${schedulerHandoffPackage}/bin/init";
    contents = [ schedulerHandoffPackage ];
  };

  schedulerHandoffCheck = installedCheck {
    name = "scheduler-handoff";
    cpus = 2;
  };

  remoteMemoryPackage = buildInit "basic-init-remote-memory" "tests/remote-memory.c";
  remoteMemoryDisk = vm-test.installedDisk {
    name = "basic-init-remote-memory";
    init = "${remoteMemoryPackage}/bin/init";
    contents = [ remoteMemoryPackage ];
  };

  remoteMemoryCheck = installedCheck {
    name = "remote-memory";
    cpus = 2;
  };

  posixSpawnStressPackage = buildInit "basic-init-posix-spawn-stress" "tests/posix-spawn-stress.c";
  posixSpawnStressDisk = vm-test.installedDisk {
    name = "basic-init-posix-spawn-stress";
    init = "${posixSpawnStressPackage}/bin/init";
    contents = [ posixSpawnStressPackage ];
  };

  posixSpawnStressCheck = installedCheck {
    name = "posix-spawn-stress";
    heavy = true;
  };

  namedSemaphoreCheck = installedCheck {
    name = "named-semaphore";
    heavy = true;
    cpus = 2;
  };

  moduleDefinedMemory =
    pkgs.runCommand "module-defined-memory.wasm"
      {
        nativeBuildInputs = [ pkgs.wabt ];
      }
      ''
        mkdir -p $out/bin
        wat2wasm ${./tests/module-defined-memory.wat} -o $out/bin/module-defined-memory
        chmod 0755 $out/bin/module-defined-memory
      '';

  memoryAbiCheck = installedCheck {
    name = "memory-abi";
    contents = [ moduleDefinedMemory ];
  };

  initcpioPayload = pkgs.runCommand "basic-init-initcpio-payload" { } ''
    mkdir -p $out
    dd if=/dev/zero of=$out/payload bs=1M count=3 status=none
    printf 'start-of-payload' | dd of=$out/payload bs=1 seek=0 conv=notrunc status=none
    printf 'middle-of-payload' | dd of=$out/payload bs=1 seek=1572864 conv=notrunc status=none
    printf 'end-of-payload' | dd of=$out/payload bs=1 seek=3145712 conv=notrunc status=none
  '';

  initcpioCheck = installedCheck {
    name = "initcpio";
    contents = [ initcpioPayload ];
  };

  # This exercises musl's __wasm_setjmp/__wasm_longjmp helpers and proves the
  # platform compiler flags lower ordinary consumer call sites.
  setjmpCheck = installedCheck { name = "setjmp"; };

  sigsetjmpCheck = installedCheck { name = "sigsetjmp"; };

  sigsetjmpHandlerCheck = installedCheck { name = "sigsetjmp-handler"; };

  signalSyscallReturnCheck =
    name: extraFlags:
    installedCheck {
      name = "signal-syscall-return-${name}";
      source = "tests/signal-syscall-return.c";
      inherit extraFlags;
    };

  kernelMemoryGrowthCheck = installedCheck {
    name = "kernel-memory-growth";
    cpus = 2;
  };
in
(buildInitWith "basic-init" "init.c" "").overrideAttrs (old: {
  passthru = (old.passthru or { }) // {
    inherit posixSpawnStressDisk remoteMemoryDisk schedulerHandoffDisk;
    checks = {
      auxv = installedCheck { name = "auxv"; };
      boot = installedCheck { name = "boot"; };
      brk = installedCheck { name = "brk"; };
      cancellation = installedCheck { name = "cancellation"; };
      clone = installedCheck { name = "clone"; };
      clone-fd = installedCheck { name = "clone-fd"; };
      clone-job-control = installedCheck { name = "clone-job-control"; };
      clone-latency = installedCheck { name = "clone-latency"; };
      clone-multithreaded-no-vm = installedCheck { name = "clone-multithreaded-no-vm"; };
      clone-memory-limit = installedCheck { name = "clone-memory-limit"; };
      clone-nested = installedCheck { name = "clone-nested"; };
      clone-no-vm = installedCheck { name = "clone-no-vm"; };
      clone-return = installedCheck { name = "clone-return"; };
      clone-signal-handler = installedCheck { name = "clone-signal-handler"; };
      clone-signals = installedCheck { name = "clone-signals"; };
      clone-tid = installedCheck { name = "clone-tid"; };
      clone-tls = installedCheck { name = "clone-tls"; };
      credentials = installedCheck { name = "credentials"; };
      cwd = installedCheck { name = "cwd"; };
      eventfd-unix = installedCheck { name = "eventfd-unix"; };
      exec-args = installedCheck { name = "exec-args"; };
      futex = installedCheck { name = "futex"; };
      initcpio = initcpioCheck;
      kernel-memory-growth = kernelMemoryGrowthCheck;
      large-executable = installedCheck { name = "large-executable"; };
      malloc = installedCheck { name = "malloc"; };
      malloc-failure = installedCheck { name = "malloc-failure"; };
      malloc-thread = installedCheck { name = "malloc-thread"; };
      memory-abi = memoryAbiCheck;
      named-semaphore = namedSemaphoreCheck;
      proc-self-mem = installedCheck { name = "proc-self-mem"; };
      posix-spawn-stress = posixSpawnStressCheck;
      pty = installedCheck { name = "pty"; };
      remote-memory = remoteMemoryCheck;
      scheduler-handoff = schedulerHandoffCheck;
      setjmp = setjmpCheck;
      signal-syscall-return = signalSyscallReturnCheck "plain" "";
      signal-syscall-return-sjlj = signalSyscallReturnCheck "sjlj" "-DUSE_SJLJ";
      signal-correctness = installedCheck { name = "signal-correctness"; };
      sigsetjmp = sigsetjmpCheck;
      sigsetjmp-handler = sigsetjmpHandlerCheck;
      pthread-no-tls = installedCheck { name = "pthread-no-tls"; };
      thread-local = installedCheck { name = "thread-local"; };
      threads = installedCheck { name = "threads"; };
      timer = installedCheck { name = "timer"; };
      tls = installedCheck { name = "tls"; };
      user-memory-growth = installedCheck { name = "user-memory-growth"; };
      user-memory-rlimit = installedCheck { name = "user-memory-rlimit"; };
      wallclock = installedCheck { name = "wallclock"; };
    };
  };
})

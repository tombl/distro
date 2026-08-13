# Local runner APK walkthrough

`all-packages.cast` is an asciinema recording of a real local wasm32 Linux
runner session. The guest starts with the minimal base system, installs the
complete mounted APK repository at runtime, exercises every package, audits all
39 installed packages, and powers off cleanly.

Replay it with:

```sh
nix run nixpkgs#asciinema -- play artifacts/userland-demo/all-packages.cast
```

`all-packages.txt` is an ANSI-filtered transcript for review and search. The
service and boot payloads (`basic-init`, `linux-guest-agent`, and
`lowland-boot`) are inspected rather than launched over the already-running
init/agent. Library packages are exercised through real consumers: Python for
ncurses, readline, and zlib, and apk/OpenSSL/curl for the CA bundle.

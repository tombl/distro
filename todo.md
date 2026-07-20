# Roadmap

## Now

1. Land the early VM test primitive and instantiate checks for boot, root filesystem setup, and known kernel/userspace regressions.
2. Enable BusyBox's NOMMU build, reproduce each failure before fixing it, and replace remaining fork- or vfork-shaped control flow with explicit spawn operations.
3. Prove the musl process substrate: `clone()`, `posix_spawn()`, `execve()`, pipes, file actions, waiting, signals, TLS, and cancellation.
4. Rebuild the host and target package scopes on the clean stack, then expose one `mkRootfs` which produces a writable ext4 image.
5. Land the guest agent and its SDK as the production command and file boundary; move the CLI and demo site onto that SDK.

## Later

- Move the `--table-base=3` signal-sentinel reservation from `packages/platform.nix`
  into the LLVM fork's wasm32-unknown-linux-musl link driver default, so builds
  outside this stdenv can't silently regress it. Deferred because changing clang
  forces a full toolchain + world rebuild; batch it with the next LLVM bump.

- Land framebuffer and input support with guest-visible integration tests, then add basic DRM only when its userspace memory requirements are supportable.
- Add outbound UDP and browser `fetch` transports to the networking layer.
- Package a useful initial software set and document the Nix-to-JavaScript build path.
- Revisit x86 execution, Python, and guest Node after the core SDK is reliable.

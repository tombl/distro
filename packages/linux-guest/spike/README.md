# PROTOTYPE: redesign phase 0 risk spike

Rough code that proves out the risks in `/var/tmp/linux-api-rethink/DESIGN-v3.md` §5. Phases 1–7 redo all of it properly. Nothing here is imported by the package.

- `lib.ts`: a newc writer, the agent as an initramfs plugin, and the host-driven boot (DESIGN-v3 §3 steps 3–7).
- `ab.ts`: risks (a) and (b), the agent as `/init` and `switch_root` as PID 1's step.
- `boottime.ts old|new`: risk (e), from `bootMachine()` to the first `run(["true"])`.
- `serial.ts`: risk (d), `/sys/block/vdX/serial`.
- `initrd-log.ts`: the kernel log lines for the pulled initrd.
- `ip.ts nic|none`: risk (c), the kernel's `ip=` with and without a NIC.
- `fg.ts`: risks (f) and (g), a virtio-fs overlay lower layer and a host-made terminal.
- `power.ts <scenario>`: risks (h), (i) and (j): BusyBox poweroff, halt and reboot, `shutdown()` through the agent's hook or the kernel button, a lane-driven shutdown, and `reboot: "restart"`.
- `agentless.ts poweroff|reboot`: risk (j) with no agent, using the kernel power button.

The power scenarios need the kernel from tombl/linux `redesign/power-spike`.

Run from `packages/linux-guest` once `packages/kernel/vmlinux.wasm` is in place, with `LOWLAND_TEST_ASSETS` set (or let `tests/assets.ts` build it). Build the prototype agent with:

    nix build .#legacyPackages.x86_64-linux.guest-agent -o /var/tmp/linux-api-rethink/spike/agent

`SPIKE_AGENT` overrides the binary path.

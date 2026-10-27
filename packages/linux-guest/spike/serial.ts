// PROTOTYPE (phase 0 spike, risk d): a virtio-blk serial reaches
// /sys/block/vdX/serial. Uses today's agent boot (agent disk + label scan).
import { blockDevice, bootMachine } from "@lowland/kernel";
import { guestAgent } from "../src/index.ts";
import { rootfs } from "../tests/assets.ts";

const disk = (bytes: Uint8Array, serial?: string) =>
  blockDevice(
    {
      capacity: bytes.byteLength,
      read(offset, target) {
        const source = bytes.subarray(offset, offset + target.byteLength);
        target.set(source);
        return source.byteLength;
      },
    },
    serial === undefined ? {} : { serial },
  );

const guest = guestAgent();
const scratch = new Uint8Array(1 << 20);
const machine = await bootMachine({
  cpus: 1,
  plugins: [
    guest,
    disk(rootfs, "m0"),
    disk(scratch, "data-disk-01234567890".slice(0, 20)),
    disk(scratch),
  ],
});
const result = await guest.run([
  "sh",
  "-c",
  'for d in /sys/block/vd*; do printf "%s=[%s]\\n" "${d##*/}" "$(cat $d/serial)"; done',
]);
console.log(new TextDecoder().decode(result.stdout), new TextDecoder().decode(result.stderr));
machine.close();
await machine.closed;

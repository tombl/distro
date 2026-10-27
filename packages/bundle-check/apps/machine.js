// A machine with no guest agent, which boots its own init.
import { blockDevice, bootMachine } from "lowland/machine";

const bytes = new Uint8Array(await (await fetch("/root.ext4")).arrayBuffer());
export const machine = await bootMachine({
  cpus: 1,
  args: ["root=/dev/vda", "rw"],
  plugins: [blockDevice({ capacity: bytes.byteLength, read: (offset, target) => 0 })],
});

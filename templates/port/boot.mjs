import { readFile } from "node:fs/promises";
import { blockDevice, bootMachine } from "@lowland/kernel";
import { guestAgent } from "@lowland/guest";

const image = await readFile(process.argv[2] ?? "result");
const root = blockDevice({
  capacity: image.byteLength,
  read(offset, target) {
    const source = image.subarray(offset, offset + target.byteLength);
    target.set(source);
    return source.byteLength;
  },
});

const guest = guestAgent();
await using machine = await bootMachine({ cpus: 1, plugins: [root, guest] });
const { status, stdout, stderr } = await guest.run(["hello"]);
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = status.success ? 0 : 1;

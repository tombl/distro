import { bootMachine } from "lowland/machine";
import { guestAgent } from "lowland/guest";

const guest = guestAgent({
  mounts: [{ path: "/", source: process.argv[2] ?? "result", type: "erofs", mode: "overlay" }],
});
await using machine = await bootMachine({ cpus: 1, plugins: [guest] });
const { status, stdout, stderr } = await guest.run(["hello"]);
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = status.success ? 0 : 1;

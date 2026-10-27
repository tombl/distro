// The layers beneath Linux, with the canonical image.
import { bootMachine } from "lowland/machine";
import { guestAgent } from "lowland/guest";
import { rootImage } from "lowland/image";

const guest = guestAgent({ mounts: [rootImage()] });
export const machine = await bootMachine({ cpus: 1, plugins: [guest] });

// A negative control: lowland/image alongside the machine, checked as if only
// the image were imported, so the check itself must report the kernel.
import { bootMachine } from "lowland/machine";
import { rootImage } from "lowland/image";

export const parts = [bootMachine, rootImage()];

// The minimal application with the canonical image.
import { Linux } from "lowland";
import { rootImage } from "lowland/image";

export const linux = await Linux.create({ image: rootImage() });

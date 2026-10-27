// The minimal application with its own image.
import { Linux } from "lowland";

export const linux = await Linux.create({ image: "/app.erofs" });

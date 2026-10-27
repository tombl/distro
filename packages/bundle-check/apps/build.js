// The Node-only image builder, which boots the builder image.
import { buildImage } from "lowland/image/build";

await buildImage({ packages: ["busybox"], output: "app.erofs" });

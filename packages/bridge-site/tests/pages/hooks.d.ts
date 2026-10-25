// What the test pages install on their global object, as specs see it inside
// page.evaluate(). vm.ts sets only bridgeOrigin.
import type { hooks } from "./stub.ts";

type Hooks = typeof hooks;

declare global {
  interface Window extends Hooks {}
}

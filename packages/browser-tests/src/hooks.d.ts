// The scenario hooks src/app.ts installs on the page's global object, as
// specs see them inside page.evaluate().
import type { hooks } from "./app.ts";

type Hooks = typeof hooks;

declare global {
  interface Window extends Hooks {}
}

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const run = fileURLToPath(new URL("../src/run.ts", import.meta.url));

/** Runs the runner CLI from source, the way `node src/run.ts` does. */
export function spawn_runner(args: readonly string[]) {
  return spawn(process.execPath, [run, ...args], { stdio: "pipe" });
}

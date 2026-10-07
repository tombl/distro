// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { assert_worker_active, HALT_KERNEL, kernel_imports } from "../src/wasm.ts";

test("a halted worker rejects later guest syscalls", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let terminations = 0;
  const imports = kernel_imports({
    is_worker: true,
    memory,
    spawn_worker: () => 0,
    boot_console_write() {},
    boot_console_close() {},
    terminate_machine() { terminations++; },
    run_on_main() {},
    get_user_context: () => null,
    worker_exit() {},
  });

  assert.doesNotThrow(assert_worker_active);
  assert.throws(() => imports.terminate_machine(0), (error) => error === HALT_KERNEL);
  assert.equal(terminations, 1);
  assert.throws(assert_worker_active, (error) => error === HALT_KERNEL);
});

// Must load before lowland/machine captures node:worker_threads' Worker.
import { drain_worker_queue, worker_queue } from "./worker-queue.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { bootMachine } from "../../src/machine/index.ts";
import { guestAgent } from "../../src/guest/index.ts";
import { root_mount } from "./assets.ts";
import { collect } from "./helpers.ts";

// A fork waits for its child's worker to copy its memory, and an exec waits
// for its successor's worker to allocate the new one. Under a worker limit
// either may wait until another process exits, so the wait must give up the
// cpu: with one cpu, holding it would stop the process that would exit.
test(
  "forks and execs wait for queued workers without holding the cpu",
  { timeout: 120_000 },
  async () => {
    const agent = guestAgent({ mounts: [root_mount()] });
    const machine = await bootMachine({ cpus: 1, plugins: [agent] });
    let debug: ReturnType<typeof setInterval> | undefined;
    try {
      const warm = await agent.exec(["true"]);
      assert.deepEqual(await warm.status, { success: true, code: 0, signal: null });
      // The warm-up's worker can outlive its reaped process by a moment.
      // Count only the workers that stay.
      for (let live = -1; live !== worker_queue.live;) {
        live = worker_queue.live;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // The shell, a sleep, and one more fit. /bin/true's child takes the last
      // slot, so its exec successor queues until the sleep exits, which needs
      // the only cpu. The loop waits, with builtins only, until the sleep has
      // execed, so the sleep's own successor never competes for a slot.
      worker_queue.limit = worker_queue.live + Number(process.env.WORKER_QUEUE_SLACK ?? 3);
      debug = process.env.WORKER_QUEUE_DEBUG
        ? setInterval(() => console.error("worker queue", JSON.stringify(worker_queue)), 2000)
        : undefined;
      const queued_before = worker_queue.queued;
      const child = await agent.exec([
        "sh",
        "-c",
        'sleep 1 & until read -r comm </proc/$!/comm && [ "$comm" = sleep ]; do :; done; /bin/true; echo done; wait',
      ]);
      const [status, stdout, stderr] = await Promise.all([
        child.status,
        collect(child.stdout),
        collect(child.stderr),
      ]);
      assert.equal(new TextDecoder().decode(stderr), "");
      assert.deepEqual(status, { success: true, code: 0, signal: null });
      assert.equal(new TextDecoder().decode(stdout), "done\n");
      assert.ok(worker_queue.queued > queued_before, "no worker was queued");
    } finally {
      clearInterval(debug);
      worker_queue.limit = Infinity;
      drain_worker_queue();
      machine.close();
      await machine.closed;
    }
  },
);

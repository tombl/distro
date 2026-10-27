import assert from "node:assert/strict";
import type { ChildProcess } from "../../src/guest/index.ts";
import { guest_test } from "./fixture.ts";
import { collect } from "./helpers.ts";

// Drives a terminal process like a user at a keyboard: everything written to
// stdout accumulates in `output`, and `expect` waits for a pattern to appear
// after what earlier expectations consumed.
class Screen {
  output = "";
  #consumed = 0;
  #changed = Promise.withResolvers<void>();
  readonly #input: WritableStreamDefaultWriter<Uint8Array>;
  readonly ended: Promise<void>;
  readonly process: ChildProcess;

  constructor(process: ChildProcess) {
    this.process = process;
    this.#input = process.stdin.getWriter();
    const decoder = new TextDecoder();
    this.ended = process.stdout.pipeTo(
      new WritableStream({
        write: (chunk) => {
          this.output += decoder.decode(chunk, { stream: true });
          this.#changed.resolve();
          this.#changed = Promise.withResolvers();
        },
      }),
    );
  }

  async type(text: string) {
    await this.#input.write(new TextEncoder().encode(text));
  }

  async expect(pattern: RegExp, timeout = 20_000): Promise<RegExpExecArray> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const match = pattern.exec(this.output.slice(this.#consumed));
      if (match) {
        this.#consumed += match.index + match[0].length;
        return match;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        assert.fail(`expected ${pattern} in ${JSON.stringify(this.output.slice(this.#consumed))}`);
      }
      await Promise.race([
        this.#changed.promise,
        new Promise((resolve) => setTimeout(resolve, remaining)),
      ]);
    }
  }
}

guest_test("terminal processes", async (t, fixture) => {
  const guest = await fixture.spawn();

  await t.test("runs on a controlling terminal of the requested size", async () => {
    const child = await guest.spawn(
      ["sh", "-c", "[ -t 0 ] && [ -t 1 ] && [ -t 2 ] && tty && stty size && echo oops >&2"],
      { terminal: { rows: 30, columns: 100 } },
    );
    assert.equal(child.terminal, true);
    const [output, errors, status] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      child.status,
    ]);
    const text = new TextDecoder().decode(output);
    // Standard error shares the terminal with standard output.
    assert.match(text, /^\/dev\/pts\/\d+\r\n30 100\r\noops\r\n$/);
    assert.equal(errors.byteLength, 0);
    assert.deepEqual(status, { success: true, code: 0, signal: null });
  });

  await t.test("leads a session with the terminal as its controlling terminal", async () => {
    // Opening /dev/tty needs a controlling terminal; field 6 of stat is the
    // session, and field 7 the controlling terminal's device.
    const result = await guest.run(
      [
        "sh",
        "-c",
        'set -- $(cat /proc/$$/stat); [ "$1" = "$6" ] && [ "$7" != 0 ] && exec 3</dev/tty && echo controlling',
      ],
      { terminal: true },
    );
    assert.deepEqual(result.status, { success: true, code: 0, signal: null });
    assert.equal(new TextDecoder().decode(result.stdout), "controlling\r\n");
  });

  await t.test("reports exit codes and ends output when the terminal closes", async () => {
    const child = await guest.spawn(["sh", "-c", "echo bye; exit 7"], { terminal: true });
    const output = collect(child.stdout);
    assert.deepEqual(await child.status, { success: false, code: 7, signal: null });
    assert.equal(new TextDecoder().decode(await output), "bye\r\n");
  });

  await t.test("delivers SIGWINCH on resize", async () => {
    const screen = new Screen(
      await guest.spawn(
        ["sh", "-c", 'trap "stty size" WINCH; echo ready; while :; do sleep 0.05; done'],
        { terminal: { rows: 24, columns: 80 } },
      ),
    );
    try {
      await screen.expect(/ready\r\n/);
      await screen.process.resize({ rows: 50, columns: 132 });
      await screen.expect(/50 132\r\n/);
    } finally {
      await screen.process[Symbol.asyncDispose]();
    }
  });

  // The terminal's foreground process group, as /proc reports it for any
  // process on that terminal: the shell owns it while it reads a command.
  async function foreground_group(pid: number) {
    const stat = await guest.fs.readTextFile(`/proc/${pid}/stat`);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { group: Number(fields[2]), foreground: Number(fields[5]) };
  }

  async function until_job_runs(shell: number) {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const { group, foreground } = await foreground_group(shell);
      if (foreground !== group) return;
      if (Date.now() >= deadline) assert.fail("no job took over the terminal");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  await t.test("supports job control", async () => {
    const screen = new Screen(
      await guest.spawn(["sh"], { terminal: true, env: { PS1: "$ ", ENV: "/dev/null" } }),
    );
    const shell = screen.process.pid;
    const job_state = async () => {
      await screen.type('echo "state=$(cut -d" " -f3 /proc/$!/stat)"\n');
      return (await screen.expect(/state=(\w)\r\n/))[1];
    };
    try {
      await screen.expect(/\$ $/);

      // A background job keeps running while the shell reads commands.
      await screen.type("sleep 100 &\n");
      await screen.expect(/\$ $/);

      // Ctrl-C interrupts only the foreground job.
      await screen.type("sleep 50\n");
      await until_job_runs(shell);
      await screen.type("\x03");
      await screen.type("echo status=$?\n");
      await screen.expect(/status=130\r\n/);
      assert.equal(await job_state(), "S");

      // Ctrl-Z stops the foreground job, and fg resumes it.
      await screen.type("fg\n");
      await until_job_runs(shell);
      await screen.type("\x1a");
      await screen.expect(/\$ $/);
      assert.equal(await job_state(), "T");
      await screen.type("fg\n");
      await until_job_runs(shell);
      await screen.type("\x03");
      await screen.type("echo status=$?\n");
      await screen.expect(/status=130\r\n/);
      await screen.type("kill -0 $! 2>/dev/null || echo reaped\n");
      await screen.expect(/reaped\r\n/);

      await screen.type("exit 3\n");
      assert.deepEqual(await screen.process.status, { success: false, code: 3, signal: null });
      await screen.ended;
    } finally {
      await screen.process[Symbol.asyncDispose]();
    }
  });

  await t.test("hangs up a terminal that background jobs hold open", async () => {
    const screen = new Screen(
      await guest.spawn(["sh"], { terminal: true, env: { PS1: "$ ", ENV: "/dev/null" } }),
    );
    await screen.expect(/\$ $/);
    await screen.type("sleep 100 &\n");
    await screen.expect(/\$ $/);
    await screen.process[Symbol.asyncDispose]();
    await screen.ended;
    assert.deepEqual(await screen.process.status, {
      success: false,
      code: null,
      signal: "SIGKILL",
    });
    // Resizing a closed terminal is a no-op rather than a stray ioctl.
    await screen.process.resize({ rows: 1, columns: 1 });
  });

  await t.test("gives up the terminal while a read is blocked on it", async () => {
    const child = await guest.spawn(["sleep", "30"], { terminal: true });
    const reader = child.stdout.getReader();
    const pending = reader.read();
    await child.stdin.close();
    await reader.cancel();
    assert.deepEqual(await pending, { done: true, value: undefined });
    // Giving up the terminal hangs it up, which sends its leader SIGHUP.
    await child[Symbol.asyncDispose]();
    assert.ok(["SIGHUP", "SIGKILL"].includes(String((await child.status).signal)));
  });

  await t.test("gives up the terminal while a write is blocked on it", async () => {
    const child = await guest.spawn(["sh", "-c", "stty raw -echo; echo ready; exec sleep 30"], {
      terminal: true,
    });
    const reader = child.stdout.getReader();
    let seen = "";
    while (!seen.includes("ready")) {
      const { value } = await reader.read();
      seen += new TextDecoder().decode(value);
    }
    // More than the terminal buffers while nothing reads it, which blocks
    // the guest write, but within what stdin buffers on the host, so this
    // write itself does not wait for the guest.
    const input = child.stdin.getWriter();
    await input.write(new Uint8Array(1024 * 1024).fill(0x61));
    await Promise.all([input.close(), reader.cancel()]);
    await child[Symbol.asyncDispose]();
    await child.status;
  });

  await t.test("leaves a terminal that reused the descriptor alone", async () => {
    const finished = await guest.spawn(["true"], { terminal: true });
    await finished.stdin.close();
    await collect(finished.stdout);
    await finished.status;

    const screen = new Screen(await guest.spawn(["cat"], { terminal: true }));
    try {
      await finished[Symbol.asyncDispose]();
      await screen.type("still here\n");
      await screen.expect(/still here\r\n.*still here\r\n/s);
    } finally {
      await screen.process[Symbol.asyncDispose]();
    }
  });

  await t.test("rejects resizing a process without a terminal", async () => {
    const child = await guest.spawn(["true"]);
    assert.equal(child.terminal, false);
    await assert.rejects(child.resize({ rows: 1, columns: 1 }), TypeError);
    await child.status;
    await child[Symbol.asyncDispose]();
  });
});

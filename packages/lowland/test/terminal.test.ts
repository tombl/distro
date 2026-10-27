// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { rootImage } from "../src/image/index.ts";
import { Linux } from "../src/linux.ts";
import { closeTerminals, Terminal } from "./pty.ts";

const cli = fileURLToPath(new URL("../src/cli/cli.ts", import.meta.url));

/** Runs `lowland run` with `args` on a host pseudoterminal. */
function lowland_on_terminal(args: string[], size?: { rows: number; columns: number }) {
  return new Terminal([process.execPath, cli, "run", ...args], size);
}

after(closeTerminals);

describe("lowland run on a terminal", () => {
  it("starts a shell on a guest terminal of the host's size", async () => {
    await using terminal = lowland_on_terminal([], { rows: 33, columns: 91 });
    let at = await terminal.waitFor(/# $/);
    terminal.type("tty; stty size; echo TERM=$TERM\r");
    at = await terminal.waitFor(/\/dev\/pts\/\d+\r\n33 91\r\nTERM=xterm\r\n/, at);
    terminal.type("exit 3\r");
    assert.deepEqual(await terminal.exited, { code: 3, restored: true });
  });

  it("puts the host terminal in raw mode while the command runs", async () => {
    await using terminal = lowland_on_terminal([
      "-t",
      "sh",
      "-c",
      "echo ready; read line; echo got=$line",
    ]);
    const at = await terminal.waitFor(/ready\r\n/);
    assert.deepEqual(await terminal.modes(), {
      icanon: false,
      echo: false,
      isig: false,
      opost: false,
    });
    // The guest's line discipline echoes and edits the line instead.
    terminal.type("helo\x7flo\r");
    await terminal.waitFor(/got=hello\r\n/, at);
    assert.deepEqual(await terminal.exited, { code: 0, restored: true });
  });

  it("forwards resizes to the guest terminal", async () => {
    await using terminal = lowland_on_terminal([
      "-t",
      "sh",
      "-c",
      'trap "stty size; exit 5" WINCH; echo ready; while :; do sleep 0.1; done',
    ]);
    const at = await terminal.waitFor(/ready\r\n/);
    terminal.resize(40, 120);
    await terminal.waitFor(/40 120\r\n/, at);
    assert.deepEqual(await terminal.exited, { code: 5, restored: true });
  });

  it("gives the shell job control", async () => {
    await using terminal = lowland_on_terminal([]);
    let at = await terminal.waitFor(/# $/);
    // A job that says when it starts and when it continues, which it does
    // as the foreground job.
    terminal.type(
      "sh -c 'trap \"echo continued\" CONT; echo started $$; while :; do sleep 1; done'\r",
    );
    at = await terminal.waitFor(/started \d+\r\n/, at);
    const pid = /started (\d+)\r\n/.exec(terminal.output)![1];
    // Ctrl-Z stops the foreground job, not lowland.
    terminal.type("\x1a");
    at = await terminal.waitFor(/# $/, at);
    terminal.type(`echo state=$(cut -d' ' -f3 /proc/${pid}/stat)\r`);
    at = await terminal.waitFor(/state=T\r\n[^]*# $/, at);
    terminal.type("fg\r");
    at = await terminal.waitFor(/continued\r\n/, at);
    // Ctrl-C interrupts it, and only it.
    terminal.type("\x03");
    at = await terminal.waitFor(/# $/, at);
    terminal.type("echo status=$?\r");
    at = await terminal.waitFor(/status=130\r\n/, at);
    terminal.type("exit\r");
    assert.deepEqual(await terminal.exited, { code: 0, restored: true });
  });

  it("reports the command's exit status and its signals", async () => {
    await using exited = lowland_on_terminal(["-t", "sh", "-c", "exit 7"]);
    assert.deepEqual(await exited.exited, { code: 7, restored: true });
    await using killed = lowland_on_terminal(["-t", "sh", "-c", "kill -TERM $$"]);
    assert.deepEqual(await killed.exited, { code: 143, restored: true });
  });

  it("forwards signals sent to lowland and restores the terminal", async () => {
    const traps = ["INT", "TERM", "HUP"]
      .map((name, index) => `trap "echo got ${name}; exit ${42 + index}" ${name}`)
      .join("; ");
    for (const [signal, code] of [
      ["SIGINT", 42],
      ["SIGTERM", 43],
      ["SIGHUP", 44],
    ] as const) {
      await using terminal = lowland_on_terminal([
        "-t",
        "sh",
        "-c",
        `${traps}; echo ready; while :; do sleep 0.1; done`,
      ]);
      const at = await terminal.waitFor(/ready\r\n/);
      terminal.signal(signal);
      await terminal.waitFor(new RegExp(`got ${signal.slice(3)}\r\n`), at);
      assert.deepEqual(await terminal.exited, { code, restored: true }, signal);
    }
  });

  it("passes the guest terminal's output through unchanged", async () => {
    // With the guest's own output processing off, a bare LF moves the
    // cursor down without returning it, as full-screen programs expect.
    await using terminal = lowland_on_terminal(["-t", "sh", "-c", "stty -opost; printf 'abc\\nX'"]);
    assert.deepEqual(await terminal.exited, { code: 0, restored: true });
    assert.equal(terminal.output, "abc\nX");
  });

  it("fails rather than garble output when it cannot set the terminal up", async () => {
    // Without stty, lowland cannot turn off the host's output processing.
    await using terminal = new Terminal([
      "env",
      "PATH=/nonexistent",
      process.execPath,
      cli,
      "run",
      "-t",
      "true",
    ]);
    assert.deepEqual(await terminal.exited, { code: 125, restored: true });
    assert.match(terminal.output, /lowland run: cannot turn off the terminal's output processing/);
  });

  it(
    "hangs up the guest terminal when its host reader goes away",
    { timeout: 60_000 },
    async () => {
      // Like lowland run -t yes | head -n 1 typed at a terminal.
      await using terminal = new Terminal([
        "sh",
        "-c",
        `"${process.execPath}" "${cli}" run -t yes | head -n 1`,
      ]);
      assert.deepEqual(await terminal.exited, { code: 0, restored: true });
      assert.match(terminal.output, /^y\r/);
    },
  );

  it("restores the terminal when the command cannot run", async () => {
    await using terminal = lowland_on_terminal(["-t", "/no/such/command"]);
    assert.deepEqual(await terminal.exited, { code: 127, restored: true });
    assert.match(terminal.output, /lowland run: \/no\/such\/command: command not found/);
  });

  it("keeps pipes for a command given without -t", async () => {
    await using terminal = lowland_on_terminal(["sh", "-c", "test -t 0 || echo pipes"]);
    assert.deepEqual(await terminal.exited, { code: 0, restored: true });
    assert.match(terminal.output, /^pipes\r\n$/);
  });
});

describe("Linux terminals", () => {
  it("runs a command on a terminal and resizes it", async () => {
    await using linux = await Linux.create({ image: rootImage() });
    const result = await linux.run(["sh", "-c", "test -t 0 && stty size; echo error >&2"], {
      terminal: { rows: 30, columns: 100 },
    });
    assert.deepEqual(result.status, { success: true, code: 0, signal: null });
    assert.equal(new TextDecoder().decode(result.stdout), "30 100\r\nerror\r\n");
    assert.equal(result.stderr.byteLength, 0);

    const shell = await linux.spawn(
      ["sh", "-c", 'trap "stty size; exit 4" WINCH; echo ready; while :; do sleep 0.1; done'],
      { terminal: true },
    );
    assert.equal(shell.terminal, true);
    const decoder = new TextDecoder();
    let output = "";
    const reader = shell.stdout.getReader();
    // The trap is set once the shell prints ready.
    while (!output.includes("ready\r\n")) {
      const { done, value } = await reader.read();
      assert.ok(!done, output);
      output += decoder.decode(value, { stream: true });
    }
    await shell.resize({ rows: 50, columns: 132 });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    assert.deepEqual(await shell.status, { success: false, code: 4, signal: null });
    assert.equal(output, "ready\r\n50 132\r\n");
  });
});

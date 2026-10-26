// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const harness = fileURLToPath(new URL("pty.py", import.meta.url));

/** Terminals not yet disposed, for `closeTerminals()`. */
const open = new Set<Terminal>();

/**
 * Disposes every terminal still open. A test that times out never reaches
 * its own disposal, so suites run this after their tests.
 */
export async function closeTerminals() {
  await Promise.all([...open].map((terminal) => terminal[Symbol.asyncDispose]()));
}

/** The terminal modes lowland run is expected to switch off and restore. */
export interface Modes {
  icanon: boolean;
  echo: boolean;
  isig: boolean;
  opost: boolean;
}

/** How a command run on a terminal ended. */
export interface TerminalExit {
  code: number;
  /** The command left the terminal's modes as they were before it started. */
  restored: boolean;
}

/**
 * A command running on a host pseudoterminal, driven like a user at a
 * terminal emulator: through `pty.py`, since Node has no pseudoterminals of
 * its own.
 */
export class Terminal {
  /** Everything the terminal has displayed so far, byte for byte. */
  output = "";
  readonly exited: Promise<TerminalExit>;

  readonly #harness;
  #waiters = new Set<() => void>();
  #modes: ((modes: Modes) => void)[] = [];

  constructor(command: string[], { rows = 24, columns = 80 } = {}) {
    this.#harness = spawn("python3", ["-I", harness, `${rows}`, `${columns}`, ...command], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    open.add(this);
    const { promise, resolve, reject } = Promise.withResolvers<TerminalExit>();
    this.exited = promise;
    // A test that is done with the terminal early need not await its exit.
    promise.catch(() => {});
    this.#harness.on("error", reject);
    this.#harness.on("close", (status) =>
      reject(new Error(`pty.py exited ${status} before the command did:\n${this.output}`)),
    );
    createInterface({ input: this.#harness.stdout }).on("line", (line) => {
      const event = JSON.parse(line);
      if ("output" in event) {
        this.output += event.output;
        for (const waiter of this.#waiters) waiter();
      } else if ("termios" in event) {
        this.#modes.shift()?.(event.termios);
      } else if ("exit" in event) {
        resolve({ code: event.exit, restored: event.restored });
        this.#harness.stdin.end();
      }
    });
  }

  #send(request: object) {
    this.#harness.stdin.write(`${JSON.stringify(request)}\n`);
  }

  /** Types `text` on the terminal. */
  type(text: string) {
    this.#send({ write: text });
  }

  /** Resizes the terminal, which sends the command `SIGWINCH`. */
  resize(rows: number, columns: number) {
    this.#send({ resize: [rows, columns] });
  }

  /** Sends a signal to the command. */
  signal(name: NodeJS.Signals) {
    this.#send({ signal: name });
  }

  /** The terminal's current modes. */
  modes(): Promise<Modes> {
    return new Promise((resolve) => {
      this.#modes.push(resolve);
      this.#send({ termios: true });
    });
  }

  /**
   * Waits until the output after `from` matches `pattern`, and returns the
   * offset just past the match, for the next wait to start from.
   */
  async waitFor(pattern: RegExp, from = 0, timeout = 60_000): Promise<number> {
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const check = () => {
      const match = pattern.exec(this.output.slice(from));
      if (match) resolve(from + match.index + match[0].length);
    };
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${pattern} in:\n${this.output.slice(from)}`)),
      timeout,
    );
    this.#waiters.add(check);
    check();
    try {
      return await Promise.race([
        promise,
        this.exited.then(() => {
          check();
          throw new Error(`exited before ${pattern} in:\n${this.output.slice(from)}`);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.#waiters.delete(check);
    }
  }

  /**
   * Ends the harness, which SIGKILLs the command if it is still running, so
   * a test that fails early leaves no machine behind.
   */
  async [Symbol.asyncDispose]() {
    open.delete(this);
    if (this.#harness.exitCode !== null || this.#harness.signalCode !== null) return;
    const closed = new Promise((resolve) => this.#harness.once("close", resolve));
    this.#harness.stdin.end();
    const timer = setTimeout(() => this.#harness.kill("SIGKILL"), 10_000);
    await closed;
    clearTimeout(timer);
  }
}

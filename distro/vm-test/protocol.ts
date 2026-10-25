export const PASS = "::vm-test::pass";
export const FAIL = "::vm-test::fail";

export class LineDecoder {
  #buffer = "";
  #decoder = new TextDecoder();

  write(chunk: Uint8Array): string[] {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    return this.#lines(false);
  }

  close(): string[] {
    this.#buffer += this.#decoder.decode();
    return this.#lines(true);
  }

  #lines(flush: boolean) {
    const lines: string[] = [];
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      lines.push(this.#buffer.slice(0, newline).replace(/\r$/, ""));
      this.#buffer = this.#buffer.slice(newline + 1);
    }
    if (flush && this.#buffer !== "") {
      lines.push(this.#buffer.replace(/\r$/, ""));
      this.#buffer = "";
    }
    return lines;
  }
}

export type Result = { passed: true } | { passed: false; reason: string };

export function parseResult(line: string): Result | undefined {
  if (line === PASS) return { passed: true };
  if (line === FAIL) return { passed: false, reason: "guest reported failure" };
  if (line.startsWith(`${FAIL}: `)) {
    return { passed: false, reason: line.slice(FAIL.length + 2) };
  }
  return undefined;
}

import assert from "node:assert/strict";
import { LineDecoder, parseResult } from "./protocol.js";

const encoder = new TextEncoder();

Deno.test("decodes records split across arbitrary chunks", () => {
  const decoder = new LineDecoder();
  const lines = [
    ...decoder.write(encoder.encode("booting\n::tombl-vm-")),
    ...decoder.write(encoder.encode("test::pass\r")),
    ...decoder.write(encoder.encode("\n")),
  ];

  assert.deepEqual(lines, ["booting", "::tombl-vm-test::pass"]);
  assert.deepEqual(parseResult(lines[1]), { passed: true });
});

Deno.test("preserves a guest failure explanation", () => {
  assert.deepEqual(parseResult("::tombl-vm-test::fail: getcwd returned /"), {
    passed: false,
    reason: "getcwd returned /",
  });
});

Deno.test("ignores marker-like workload output", () => {
  assert.equal(parseResult("prefix ::tombl-vm-test::pass"), undefined);
  assert.equal(parseResult("::tombl-vm-test::failure"), undefined);
});

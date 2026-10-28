// SPDX-License-Identifier: MIT

// It checks the machine layer against the guest ABI, so it lives with the
// guest tests: the machine layer builds and tests on its own.
import assert from "node:assert/strict";
import test from "node:test";
import { E } from "../../src/guest/abi.ts";
import { SystemError } from "../../src/machine/error.ts";

test("SystemError names every errno the guest ABI checks", () => {
  for (const [name, errno] of Object.entries(E)) {
    const error = new SystemError(errno);
    assert.equal(error.code, `E${name}`);
    assert.equal(error.errno, errno);
    assert.equal(new SystemError(`E${name}` as never).errno, errno);
  }
});

test("SystemError takes a code or a number, and a message", () => {
  const named = new SystemError("ENOENT");
  assert.equal(named.message, "ENOENT");
  assert.equal(named.name, "SystemError");
  const described = new SystemError("EIO", "the disk went away");
  assert.equal(described.message, "the disk went away");
  assert.equal(described.code, "EIO");
  const unnamed = new SystemError(200);
  assert.equal(unnamed.code, undefined);
  assert.equal(unnamed.message, "E200");
  assert.throws(() => new SystemError("ENOPE" as never), TypeError);
});

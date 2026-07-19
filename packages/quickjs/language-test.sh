#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

# Core language, JSON, classes, BigInt, error propagation, std file I/O, and the
# async machinery (Promise/async-await plus os.setTimeout) all in one module so
# top-level await drives the same job queue qjs drains in js_std_loop. Written as
# a module (import ... from 'qjs:std'/'qjs:os') so it also exercises the built-in
# module loader.
cat >/tmp/lang.mjs <<'JS'
import * as std from 'qjs:std';
import * as os from 'qjs:os';

function assert(cond, msg) {
  if (!cond) throw new Error("assert failed: " + msg);
}

// Arithmetic and strings.
assert(2 ** 10 === 1024, "pow");
assert(Math.floor(Math.sqrt(144)) === 12, "sqrt");
assert("hello".toUpperCase() === "HELLO", "upper");
assert("a,b,c".split(",").join(";") === "a;b;c", "split/join");
assert(`${1 + 2}-x` === "3-x", "template");

// Closures.
function counter() {
  let n = 0;
  return () => ++n;
}
const c = counter();
assert(c() === 1 && c() === 2 && c() === 3, "closure state");

// JSON round-trip.
const obj = { a: 1, b: [2, 3], c: { d: "e" }, f: null, g: true };
const round = JSON.parse(JSON.stringify(obj));
assert(round.b[1] === 3 && round.c.d === "e" && round.g === true, "json roundtrip");

// Classes and prototype behaviour.
class Animal {
  constructor(name) { this.name = name; }
  speak() { return this.name + " makes a sound"; }
}
class Dog extends Animal {
  speak() { return this.name + " barks"; }
}
const d = new Dog("Rex");
assert(d.speak() === "Rex barks", "override");
assert(d instanceof Animal && d instanceof Dog, "instanceof chain");
assert(Object.getPrototypeOf(Dog.prototype) === Animal.prototype, "prototype chain");

// BigInt math.
const big = 2n ** 64n;
assert(big === 18446744073709551616n, "bigint pow");
assert(big + 1n === 18446744073709551617n, "bigint add");
assert(big * 2n === 36893488147419103232n, "bigint mul");

// Error propagation: caught exception carries the right message.
let caught = null;
try {
  JSON.parse("{ not json");
} catch (e) {
  caught = e;
}
assert(caught instanceof SyntaxError, "json throws SyntaxError");
try {
  assert(false, "propagated-message");
} catch (e) {
  assert(e.message === "assert failed: propagated-message", "error message preserved");
}

// std file I/O: write with std.open, read back with std.loadFile and std.open.
const path = "/tmp/qjs-io.txt";
const w = std.open(path, "w");
w.puts("line1\n");
w.puts("line2\n");
w.close();
assert(std.loadFile(path) === "line1\nline2\n", "loadFile");
const r = std.open(path, "r");
assert(r.getline() === "line1", "getline");
r.close();

// os.exec must fail loudly on wasm (no fork()); assert the stub throws a
// catchable error rather than crashing or linking a missing fork().
let execErr = null;
try {
  os.exec(["true"]);
} catch (e) {
  execErr = e;
}
assert(execErr && /no fork\(\)/.test(execErr.message), "os.exec throws no-fork error");

// Promise / async-await resolution, drained by js_std_loop.
async function compute(x) {
  const y = await Promise.resolve(x * 2);
  return y + 1;
}
const results = await Promise.all([compute(10), compute(20)]);
assert(results[0] === 21 && results[1] === 41, "async/await + Promise.all");

// os.setTimeout firing through the event loop.
const timed = await new Promise((resolve) => {
  os.setTimeout(() => resolve("timer-fired"), 20);
});
assert(timed === "timer-fired", "os.setTimeout");

std.out.puts("::qjs::all-pass\n");
JS

qjs /tmp/lang.mjs >/tmp/lang.out 2>&1 ||
  fail "qjs module exited nonzero: $(cat /tmp/lang.out)"
grep -qx '::qjs::all-pass' /tmp/lang.out ||
  fail "qjs language checks failed: $(cat /tmp/lang.out)"

# qjsc is shipped as a guest binary; confirm it runs and compiles a script to C.
cat >/tmp/hello.js <<'JS'
export function hello() { return 42; }
JS
qjsc -o /tmp/hello.c /tmp/hello.js >/tmp/qjsc.out 2>&1 ||
  fail "qjsc failed to compile to C: $(cat /tmp/qjsc.out)"
test -s /tmp/hello.c ||
  fail "qjsc produced no output"
grep -q 'uint' /tmp/hello.c ||
  fail "qjsc output is not a C bytecode array: $(cat /tmp/hello.c)"

echo "::vm-test::pass"
while :; do :; done

#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

# os.exec enumerates the live descriptor table when constructing close actions.
mount -t proc proc /proc || fail "mounting proc failed"

# Worker modules communicate through os.Worker.parent. Keep both ends alive
# only for one roundtrip so qjs's event loop can drain and exit normally.
cat >/tmp/worker.mjs <<'JS'
import * as os from 'qjs:os';

const parent = os.Worker.parent;
parent.onmessage = (event) => {
  parent.postMessage({ answer: event.data.value * 2 });
  parent.onmessage = null;
};
JS

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

// os.exec launches through posix_spawn because wasm has no fork(). Cover the
// blocking path, explicit executable selection, and a nonzero exit status.
assert(os.exec(["true"]) === 0, "os.exec PATH lookup");
assert(os.exec(["/bin/sh", "-c", "exit 7"], { usePath: false }) === 7,
       "os.exec exit status");
assert(os.exec(["busybox", "sh", "-c", "exit 4"], {
  file: "/bin/busybox",
  usePath: false,
}) === 4, "os.exec file option");

// Exercise asynchronous spawn, cwd, a replacement environment, stdout
// remapping, inherited-fd closure, and waitpid together.
const execPipe = os.pipe();
const execCommand =
  `test ! -e /proc/self/fd/${execPipe[1]} || exit 91; ` +
  'printf "%s:" "$FOO"; pwd';
const execPid = os.exec(["sh", "-c", execCommand], {
  block: false,
  cwd: "/tmp",
  env: {
    FOO: "hello",
    PATH: "/bin:/sbin:/usr/bin:/usr/sbin",
  },
  stdout: execPipe[1],
});
assert(execPid > 0, "os.exec asynchronous pid");
os.close(execPipe[1]);
const execOut = std.fdopen(execPipe[0], "r");
assert(execOut.getline() === "hello:/tmp", "os.exec environment and cwd");
assert(execOut.getline() === null, "os.exec stdout reaches EOF");
execOut.close();
const [waitedPid, waitStatus] = os.waitpid(execPid, 0);
assert(waitedPid === execPid, "os.exec waitpid");
assert((waitStatus & 0x7f) === 0 && (waitStatus >> 8) === 0,
       "os.exec asynchronous status");

// posix_spawn reports launch failures synchronously, so they surface as a
// catchable JS exception rather than as an already-reaped child.
let execErr = null;
try {
  os.exec(["/definitely/missing"], { usePath: false });
} catch (e) {
  execErr = e;
}
assert(execErr && /posix_spawn:/.test(execErr.message),
       "os.exec launch failure throws");

// Arbitrary credential changes cannot be represented by posix_spawn.
execErr = null;
try {
  os.exec(["true"], { uid: 0 });
} catch (e) {
  execErr = e;
}
assert(execErr && /uid, gid, and groups/.test(execErr.message),
       "os.exec rejects credential options");

// os.Worker must enter its pthread callback and exchange a message. This
// catches wasm signature mismatches in the pthread start routine.
const workerResult = await new Promise((resolve, reject) => {
  const worker = new os.Worker("/tmp/worker.mjs");
  const timeout = os.setTimeout(() => {
    worker.onmessage = null;
    reject(new Error("worker roundtrip timed out"));
  }, 2000);
  worker.onmessage = (event) => {
    os.clearTimeout(timeout);
    worker.onmessage = null;
    resolve(event.data);
  };
  worker.postMessage({ value: 21 });
});
assert(workerResult.answer === 42, "os.Worker roundtrip");

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

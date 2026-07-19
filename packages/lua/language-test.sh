#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

# os.execute/io.popen spawn /bin/sh, which wants /dev/null.
mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"

# Core language features that do not depend on longjmp: arithmetic, strings,
# tables, and file io. The wasm musl ships a stub longjmp (it traps), so Lua's
# error propagation and coroutine yield cannot work; those are probed below.
cat >/tmp/core.lua <<'LUA'
assert(2 ^ 10 == 1024, "pow")
assert(7 // 2 == 3, "floordiv")
assert(7 % 3 == 1, "mod")
assert(math.floor(math.sqrt(144)) == 12, "sqrt")

assert(("hello"):upper() == "HELLO", "upper")
assert(string.format("%d-%s-%0.2f", 42, "x", 1.5) == "42-x-1.50", "format")
assert(#"abcde" == 5, "len")
assert(("a,b,c"):gsub(",", ";") == "a;b;c", "gsub")
assert(("  trim  "):match("^%s*(.-)%s*$") == "trim", "match")

local t = {}
for i = 1, 5 do t[i] = i * i end
assert(#t == 5 and t[5] == 25, "table build")
local sum = 0
for _, v in ipairs(t) do sum = sum + v end
assert(sum == 55, "ipairs sum")
table.sort(t, function(a, b) return a > b end)
assert(t[1] == 25 and t[5] == 1, "sort")
local m = { a = 1, b = 2, c = 3 }
local keys = 0
for _ in pairs(m) do keys = keys + 1 end
assert(keys == 3, "pairs")

local path = "/tmp/lua-io.txt"
local w = assert(io.open(path, "w"))
w:write("line1\n")
w:write("line2\n")
w:close()
local r = assert(io.open(path, "r"))
assert(r:read("l") == "line1", "read line")
assert(r:read("a") == "line2\n", "read rest")
r:close()

print("::lua::core-pass")
LUA

lua /tmp/core.lua >/tmp/core.out 2>&1 ||
  fail "lua core script exited nonzero: $(cat /tmp/core.out)"
grep -qx '::lua::core-pass' /tmp/core.out ||
  fail "lua core features failed: $(cat /tmp/core.out)"

# Everything below exercises platform edges. Report behavior; do not gate the
# test, since the point is to record how the no-fork/no-longjmp platform reacts.

# Coroutine yield unwinds through luaD_throw -> longjmp, which traps here.
cat >/tmp/coro.lua <<'LUA'
local co = coroutine.create(function(a)
  local b = coroutine.yield(a + 1)
  return b * 2
end)
print("resume1:", coroutine.resume(co, 10))
print("resume2:", coroutine.resume(co, 5))
print("status:", coroutine.status(co))
LUA
lua /tmp/coro.lua >/tmp/coro.out 2>&1
echo "--- coroutine (exit $?) ---"
cat /tmp/coro.out

# Error handling: pcall recovers via longjmp, which traps here.
cat >/tmp/err.lua <<'LUA'
print("pcall:", pcall(function() error("boom") end))
LUA
lua /tmp/err.lua >/tmp/err.out 2>&1
echo "--- pcall/error (exit $?) ---"
cat /tmp/err.out

# os.execute (system()) and io.popen (popen()) go through the no-fork spawn
# path; package.loadlib should fail gracefully (no dlopen).
cat >/tmp/probe.lua <<'LUA'
print("os.execute:", os.execute("exit 3"))
local ph = io.popen("echo popen-output")
if ph then
  print("io.popen:", (ph:read("a") or ""):gsub("%s+$", ""), ph:close())
else
  print("io.popen: open-failed")
end
print("loadlib:", package.loadlib("/nonexistent.so", "luaopen_x"))
LUA
lua /tmp/probe.lua >/tmp/probe.out 2>&1
echo "--- spawn/loadlib (exit $?) ---"
cat /tmp/probe.out
echo "--- end probes ---"

echo "::vm-test::pass"
while :; do :; done

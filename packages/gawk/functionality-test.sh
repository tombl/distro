#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

# Prove the GNU gawk shadows busybox's awk applet.
gawk --version | grep -q 'GNU Awk' || fail "not running GNU gawk"

# Arithmetic and printf.
out=$(gawk 'BEGIN { printf "%d %.2f\n", 6 * 7, 22 / 7 }')
[ "$out" = "42 3.14" ] || fail "arithmetic/printf: $out"

# Fields and field separator.
out=$(printf 'a:b:c\n' | gawk -F: '{ print $2, NF }')
[ "$out" = "b 3" ] || fail "fields: $out"

# Associative arrays and iteration with a stable sum.
out=$(printf 'apple 3\nbanana 5\napple 4\n' | gawk '
  { total[$1] += $2 }
  END { print total["apple"], total["banana"] }')
[ "$out" = "7 5" ] || fail "associative arrays: $out"

# String functions and control flow.
out=$(gawk 'BEGIN {
  s = "hello world"
  gsub(/o/, "0", s)
  print toupper(s), length(s)
}')
[ "$out" = "HELL0 W0RLD 11" ] || fail "string functions: $out"

# getline from a pipe: exercises the posix_spawn (was fork) read pipe.
out=$(gawk 'BEGIN {
  cmd = "echo piped-in"
  cmd | getline line
  close(cmd)
  print line
}')
[ "$out" = "piped-in" ] || fail "getline pipe: $out"

# system(): exercises the posix_spawn (was fork) gawk_system path.
gawk 'BEGIN { rc = system("exit 3"); if (rc != 3) exit 1 }' ||
  fail "system() did not return child exit status"

# print | command: exercises the posix_spawn write pipe.
out=$(gawk 'BEGIN { print "two\none" | "sort"; close("sort") }')
[ "$out" = "$(printf 'one\ntwo')" ] || fail "output pipe to command: $out"

# Error-path probe: a runtime fatal error (division by zero) must print a
# fatal diagnostic and exit nonzero, NOT trap. This is the path that would
# longjmp under the debugger; in normal execution gawk_exit() calls exit()
# because fatal_tag_valid is 0, so it must terminate cleanly here.
errout=$(gawk 'BEGIN { x = 1 / 0 }' 2>&1)
status=$?
[ "$status" -ne 0 ] || fail "fatal error path returned success"
case $errout in
*division*by*zero*) : ;;
*) fail "fatal error did not print a diagnostic: $errout" ;;
esac

echo "::vm-test::pass"
while :; do :; done

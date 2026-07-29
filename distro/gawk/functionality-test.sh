#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mount devtmpfs"
mkdir -p /dev/pts || fail "create /dev/pts"
mount -t devpts devpts /dev/pts || fail "mount devpts"
mount -t proc proc /proc || fail "mount proc"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

# Prove the GNU gawk shadows busybox's awk applet.
gawk --version | grep -q 'GNU Awk' || fail "not running GNU gawk"

# Arithmetic and printf.
out=$(gawk 'BEGIN { printf "%d %.2f\n", 6 * 7, 22 / 7 }')
[ "$out" = "42 3.14" ] || fail "arithmetic/printf: $out"

# Fields and field separator.
out=$(printf 'a:b:c\n' | gawk -F: '{ print $2, NF }')
[ "$out" = "b 3" ] || fail "fields: $out"

# @include must search the compiled guest AWKPATH and load the library staged
# at /usr/share/awk; ord.awk is part of gawk's installed helper set.
out=$(gawk '@include "ord.awk"
BEGIN { print ord("A") }')
[ "$out" = "65" ] || fail "@include via default AWKPATH: $out"
[ "$(gawk 'BEGIN { print ENVIRON["AWKPATH"] }')" = ".:/usr/share/awk" ] ||
  fail "default AWKPATH is not guest-visible"
grep -q '_pw_awklib = "/usr/libexec/awk/"' /usr/share/awk/passwd.awk ||
  fail "passwd.awk has the wrong helper path"

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

# A requested |& pty coprocess must expose devpts and carry data both ways.
out=$(gawk 'BEGIN {
  cmd = "tty; read line; echo reply:$line"
  PROCINFO[cmd, "pty"] = 1
  cmd |& getline ttyname
  print "PTY_MARKER" |& cmd
  fflush(cmd)
  cmd |& getline reply
  close(cmd)
  print ttyname
  print reply
}')
expected=$(printf '/dev/pts/0\nreply:PTY_MARKER')
[ "$out" = "$expected" ] || fail "pty coprocess: $out"

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

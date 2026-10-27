#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

expect() {
  expected=$1
  shift
  actual=$("$@") || fail "$* exited with $?"
  [ "$actual" = "$expected" ] || fail "$*: expected '$expected', got '$actual'"
}

for program in hello-c hello-cmake hello-meson; do
  expect "hello from C" "$program"
done
for program in hello-cxx hello-cmake-cxx hello-meson-cxx; do
  expect "hello from C++" "$program"
done
expect "Hello, world!" hello
expect "hi" hello --greeting=hi

echo "::vm-test::pass"
while :; do :; done

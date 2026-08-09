#!/bin/busybox sh

set -e

if [ ! -d /proc/self/fd ]; then
  echo "vm-test: /proc/self/fd is unavailable" >&2
  exit 1
fi

/bin/busybox ln -snf /proc/self/fd /dev/fd
/bin/busybox ln -snf /proc/self/fd/0 /dev/stdin
/bin/busybox ln -snf /proc/self/fd/1 /dev/stdout
/bin/busybox ln -snf /proc/self/fd/2 /dev/stderr

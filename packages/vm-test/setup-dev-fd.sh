#!/bin/sh

set -e

if [ ! -d /proc/self/fd ]; then
  echo "vm-test: /proc/self/fd is unavailable" >&2
  exit 1
fi

ln -snf /proc/self/fd /dev/fd
ln -snf /proc/self/fd/0 /dev/stdin
ln -snf /proc/self/fd/1 /dev/stdout
ln -snf /proc/self/fd/2 /dev/stderr

#!/bin/busybox sh

export PATH=/bin:/sbin

if IFS= read -r input; then
  printf 'console-input: %s\n' "$input"
else
  echo 'console-input: read failed' >&2
fi

exec /sbin/poweroff -f

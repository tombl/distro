#!/bin/busybox sh

# pid 1 must only rely on busybox applets, invoked explicitly: the rootfs
# ships a full userland that shadows busybox on PATH, and a shadowing package
# may not be init-safe. util-linux's setsid taught us this: it spawns the
# child and exits the parent, which as pid 1 panics the kernel.
/bin/busybox mkdir -p /dev/pts
/bin/busybox mount -t devpts devpts /dev/pts
/bin/busybox mount -t proc proc /proc
/bin/busybox ln -snf /proc/self/fd /dev/fd
/bin/busybox ln -snf /proc/self/fd/0 /dev/stdin
/bin/busybox ln -snf /proc/self/fd/1 /dev/stdout
/bin/busybox ln -snf /proc/self/fd/2 /dev/stderr
/bin/busybox mount -t sysfs sysfs /sys

# Share records contain only a fixed tag/mode and a base64-encoded absolute
# guest path. Keeping the path out of shell syntax makes spaces and metacharacters
# safe; the runner rejects control characters before constructing the record.
set -f
for parameter in $(/bin/busybox cat /proc/cmdline); do
  case "$parameter" in
  wasm.share=*)
    share="${parameter#wasm.share=}"
    tag="${share%%,*}"
    share="${share#*,}"
    mode="${share%%,*}"
    encoded_path="${share#*,}"

    case "$mode" in
    ro | rw) ;;
    *)
      echo "runner-init: invalid share mode: $mode" >&2
      continue
      ;;
    esac
    guest_path=$(/bin/busybox printf '%s' "$encoded_path" | /bin/busybox base64 -d) || {
      echo "runner-init: invalid share path encoding for $tag" >&2
      continue
    }
    case "$guest_path" in
    /*) ;;
    *)
      echo "runner-init: share path is not absolute for $tag" >&2
      continue
      ;;
    esac

    /bin/busybox mkdir -p -- "$guest_path" || {
      echo "runner-init: cannot create share mountpoint: $guest_path" >&2
      continue
    }
    /bin/busybox mount -t virtiofs -o "$mode" "$tag" "$guest_path" ||
      echo "runner-init: cannot mount $tag at $guest_path" >&2
    ;;
  esac
done
set +f

exec /bin/busybox setsid /bin/busybox cttyhack /bin/busybox sh

#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

# tar spawns each compressor through /bin/sh (posix_spawn on wasm), which needs
# a working /dev for the pipe children.
mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"

# Prove the GNU binary shadows busybox's tar applet.
tar --version | grep -q 'GNU tar' || fail "not running GNU tar"

# A small tree with known content to round-trip.
mkdir -p /tmp/src/dir
echo hello >/tmp/src/one.txt
echo world >/tmp/src/dir/two.txt
printf 'third file\n' >/tmp/src/dir/three.txt

# --- plain (uncompressed) create / list / extract round-trip ---
tar cf /tmp/plain.tar -C /tmp src || fail "create plain archive"

# The listing holds exactly the expected members.
out=$(tar tf /tmp/plain.tar | sort | tr '\n' ' ')
exp="src/ src/dir/ src/dir/three.txt src/dir/two.txt src/one.txt "
[ "$out" = "$exp" ] || fail "plain list: $out"

mkdir -p /tmp/out-plain
tar xf /tmp/plain.tar -C /tmp/out-plain || fail "extract plain archive"
[ "$(cat /tmp/out-plain/src/one.txt)" = "hello" ] || fail "plain one.txt content"
[ "$(cat /tmp/out-plain/src/dir/two.txt)" = "world" ] || fail "plain two.txt content"
cmp /tmp/src/dir/three.txt /tmp/out-plain/src/dir/three.txt || fail "plain three.txt cmp"

# --- compressor round-trips against regular-file archives ---
# For each: create (tar spawns the compressor to its stdout on the archive fd),
# confirm with the standalone decoder that the archive really is that stream
# wrapping a valid tar, then extract through tar (tar spawns the decompressor)
# and verify the extracted content byte-for-byte.
check_comp() {
  flag=$1
  ext=$2
  decoder=$3
  arc=/tmp/comp.$ext

  rm -f "$arc"
  tar "$flag" -cf "$arc" -C /tmp src || fail "$ext: create"

  # Standalone decoder proves a real <ext> stream that unwraps to a tar.
  $decoder <"$arc" >/tmp/decoded.tar 2>/dev/null || fail "$ext: standalone decode"
  tar tf /tmp/decoded.tar >/dev/null 2>&1 || fail "$ext: decoded payload is not a tar"

  # tar's own decompress path.
  rm -rf "/tmp/out-$ext"
  mkdir -p "/tmp/out-$ext"
  tar "$flag" -xf "$arc" -C "/tmp/out-$ext" || fail "$ext: extract"
  [ "$(cat "/tmp/out-$ext/src/one.txt")" = "hello" ] || fail "$ext: one.txt content"
  cmp /tmp/src/dir/three.txt "/tmp/out-$ext/src/dir/three.txt" || fail "$ext: three.txt cmp"
}

check_comp -z gz "gzip -dc"
check_comp -J xz "xz -dc"
check_comp --zstd zst "zstd -dc"
check_comp -j bz2 "bzip2 -dc"

echo "::vm-test::pass"
while :; do :; done

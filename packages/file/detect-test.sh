#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

# The magic database is compiled with the store path baked in, which does not
# exist in the VM; point libmagic at the copy shipped in the initramfs.
export MAGIC=/share/misc/magic.mgc

text=$(file -b /fixtures/hello.txt) || fail "file exited nonzero on text"
case $text in
*ASCII*text*) : ;;
*) fail "text misdetected: $text" ;;
esac

gzip=$(file -b /fixtures/hello.gz) || fail "file exited nonzero on gzip"
case $gzip in
*gzip*compressed*) : ;;
*) fail "gzip misdetected: $gzip" ;;
esac

wasm=$(file -b /bin/file) || fail "file exited nonzero on wasm binary"
case $wasm in
*WebAssembly*) : ;;
*) fail "wasm binary misdetected: $wasm" ;;
esac

echo "::vm-test::pass"
while :; do :; done

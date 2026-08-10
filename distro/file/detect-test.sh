#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

[ -f /usr/share/misc/magic.mgc ] || fail "magic database is not installed at its FHS path"

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

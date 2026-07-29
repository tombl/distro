#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

# patch may consult /dev/tty; provide a working /dev so a stray prompt cannot
# wedge the run.
mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"

# Prove the GNU binary shadows busybox's patch applet.
patch --version | grep -q 'GNU patch' || fail "not running GNU patch"

mkdir -p /tmp/w
cd /tmp/w || fail "cd failed"

printf 'line1\nline2\nline3\n' >f.txt
cat >p.diff <<'EOF'
--- f.txt
+++ f.txt
@@ -1,3 +1,3 @@
 line1
-line2
+CHANGED
 line3
EOF

# Forward apply: exit 0, content changed.
patch f.txt <p.diff || fail "forward patch returned nonzero"
grep -q '^CHANGED$' f.txt || fail "forward: CHANGED not present"
grep -q '^line2$' f.txt && fail "forward: line2 still present"

# Reverse apply (-R): back to the original.
patch -R f.txt <p.diff || fail "reverse patch returned nonzero"
grep -q '^line2$' f.txt || fail "reverse: line2 not restored"
grep -q 'CHANGED' f.txt && fail "reverse: CHANGED still present"

# Mismatched hunk: nonzero exit and a .rej file, no clobber of the target.
printf 'totally\ndifferent\nstuff\n' >bad.txt
patch -f bad.txt <p.diff
status=$?
[ "$status" -ne 0 ] || fail "reject: patch reported success on mismatch"
[ -f bad.txt.rej ] || fail "reject: no .rej file created"
grep -q '^totally$' bad.txt || fail "reject: target unexpectedly modified"

echo "::vm-test::pass"
while :; do :; done

#!/bin/busybox sh

# File and metadata operations, exercised against the GNU coreutils binaries
# (installed under /gnu/bin, ahead of busybox on PATH).

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/gnu/bin:/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

# Prove we are running GNU coreutils and not the busybox applets.
ls --version >/tmp/ls-version || fail "ls --version failed"
grep -q 'GNU coreutils' /tmp/ls-version || fail "ls is not GNU coreutils"
cp --version >/tmp/cp-version || fail "cp --version failed"
grep -q 'GNU coreutils' /tmp/cp-version || fail "cp is not GNU coreutils"

work=/tmp/coreutils-fileops
rm -rf "$work"
mkdir -p "$work/a/b/c" || fail "mkdir -p failed"
[ -d "$work/a/b/c" ] || fail "mkdir -p did not create the tree"

touch "$work/a/file1" || fail "touch failed"
[ -f "$work/a/file1" ] || fail "touch did not create a file"

printf 'the quick brown fox\n' >"$work/a/file1" || fail "writing test data failed"

# Recursive copy.
cp -r "$work/a" "$work/a-copy" || fail "cp -r failed"
cmp "$work/a/file1" "$work/a-copy/file1" || fail "cp -r produced different data"
[ -d "$work/a-copy/b/c" ] || fail "cp -r did not copy the directory tree"

# Move.
mv "$work/a-copy/file1" "$work/a-copy/file2" || fail "mv failed"
[ ! -e "$work/a-copy/file1" ] || fail "mv left its source behind"
[ -f "$work/a-copy/file2" ] || fail "mv did not create its destination"

# Symbolic link.
ln -s file2 "$work/a-copy/link" || fail "ln -s failed"
[ -L "$work/a-copy/link" ] || fail "ln -s did not create a symlink"
target=$(readlink "$work/a-copy/link") || fail "readlink failed"
[ "$target" = file2 ] || fail "readlink returned '$target' instead of file2"
cmp "$work/a-copy/link" "$work/a-copy/file2" || fail "symlink did not resolve to its target"

# Permissions and stat.
chmod 0640 "$work/a-copy/file2" || fail "chmod failed"
mode=$(stat -c '%a' "$work/a-copy/file2") || fail "stat -c %a failed"
[ "$mode" = 640 ] || fail "stat reported mode $mode instead of 640"
size=$(stat -c '%s' "$work/a-copy/file2") || fail "stat -c %s failed"
[ "$size" -eq 20 ] || fail "stat reported size $size instead of 20"

# dd copy.
dd if="$work/a/file1" of="$work/dd-out" bs=4 2>/dev/null || fail "dd failed"
cmp "$work/a/file1" "$work/dd-out" || fail "dd produced different data"

# du and df run and report something plausible.
du -s "$work" >/tmp/du-out || fail "du failed"
grep -q "$work" /tmp/du-out || fail "du did not report the directory"
dfout=$(df /tmp) || fail "df failed"
case "$dfout" in
*Filesystem*) ;;
*) fail "df did not produce a filesystem table" ;;
esac

# Recursive remove.
rm -r "$work/a" || fail "rm -r failed"
[ ! -e "$work/a" ] || fail "rm -r left the tree behind"

echo "::vm-test::pass"
while :; do :; done

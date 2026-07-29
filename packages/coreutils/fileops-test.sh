#!/bin/sh

# File and metadata operations, exercised against the GNU coreutils binaries
# (installed under /gnu/bin, ahead of the util-linux command directory).

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

contains() {
  case "$1" in
  *"$2"*) return 0 ;;
  *) return 1 ;;
  esac
}

same_file() {
  first_sum=$(sha256sum "$1") || return
  second_sum=$(sha256sum "$2") || return
  [ "${first_sum%% *}" = "${second_sum%% *}" ]
}

export PATH=/gnu/bin:/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

# Prove we are running GNU coreutils.
ls_version=$(ls --version) || fail "ls --version failed"
contains "$ls_version" "GNU coreutils" || fail "ls is not GNU coreutils"
cp_version=$(cp --version) || fail "cp --version failed"
contains "$cp_version" "GNU coreutils" || fail "cp is not GNU coreutils"

work=/tmp/coreutils-fileops
rm -rf "$work"
mkdir -p "$work/a/b/c" || fail "mkdir -p failed"
[ -d "$work/a/b/c" ] || fail "mkdir -p did not create the tree"

touch "$work/a/file1" || fail "touch failed"
[ -f "$work/a/file1" ] || fail "touch did not create a file"

printf 'the quick brown fox\n' >"$work/a/file1" || fail "writing test data failed"

# Recursive copy.
cp -r "$work/a" "$work/a-copy" || fail "cp -r failed"
same_file "$work/a/file1" "$work/a-copy/file1" ||
  fail "cp -r produced different data"
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
same_file "$work/a-copy/link" "$work/a-copy/file2" ||
  fail "symlink did not resolve to its target"

# Permissions and stat.
chmod 0640 "$work/a-copy/file2" || fail "chmod failed"
mode=$(stat -c '%a' "$work/a-copy/file2") || fail "stat -c %a failed"
[ "$mode" = 640 ] || fail "stat reported mode $mode instead of 640"
size=$(stat -c '%s' "$work/a-copy/file2") || fail "stat -c %s failed"
[ "$size" -eq 20 ] || fail "stat reported size $size instead of 20"

# dd copy.
dd if="$work/a/file1" of="$work/dd-out" bs=4 2>/dev/null || fail "dd failed"
same_file "$work/a/file1" "$work/dd-out" || fail "dd produced different data"

# du and df run and report something plausible.
du -s "$work" >/tmp/du-out || fail "du failed"
contains "$(cat /tmp/du-out)" "$work" || fail "du did not report the directory"
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

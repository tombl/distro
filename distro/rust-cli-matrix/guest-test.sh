#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export HOME=/root
export TERM=xterm
export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.com

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"
mkdir -p /root /tmp/matrix/sub || fail "creating fixtures failed"
printf 'alpha\nneedle\nomega\n' >/tmp/matrix/input.txt
printf 'nested\n' >/tmp/matrix/sub/nested.txt

rg -n needle /tmp/matrix/input.txt >/tmp/rg.out ||
  fail "ripgrep buffered search failed"
grep -qx '2:needle' /tmp/rg.out || fail "ripgrep output was wrong: $(cat /tmp/rg.out)"
if rg --mmap needle /tmp/matrix/input.txt >/tmp/rg-mmap.out 2>/tmp/rg-mmap.err; then
  fail "ripgrep --mmap unexpectedly succeeded"
fi
grep -q -- '--mmap is not supported on wasm32 Linux' /tmp/rg-mmap.err ||
  fail "ripgrep --mmap lacked an explicit diagnostic: $(cat /tmp/rg-mmap.err)"

fd -H '^input[.]txt$' /tmp/matrix >/tmp/fd.out || fail "fd search failed"
grep -qx '/tmp/matrix/input.txt' /tmp/fd.out || fail "fd output was wrong: $(cat /tmp/fd.out)"

bat --color=never --style=plain /tmp/matrix/input.txt >/tmp/bat.out || fail "bat failed"
cmp /tmp/matrix/input.txt /tmp/bat.out || fail "bat changed plain file contents"

printf 'one\ntwo\nthree\n' >/tmp/tac.in
coreutils tac /tmp/tac.in >/tmp/tac.out || fail "uutils tac file fallback failed"
printf 'three\ntwo\none\n' >/tmp/tac.want
cmp /tmp/tac.want /tmp/tac.out || fail "uutils tac output was wrong"

git init --object-format=sha1 -b main /tmp/repo >/tmp/git.out 2>&1 ||
  fail "git init failed: $(cat /tmp/git.out)"
test "$(git -C /tmp/repo rev-parse --show-object-format)" = sha1 ||
  fail "Git fixture did not use SHA-1"
printf 'tracked\nstable\n' >/tmp/repo/tracked
git -C /tmp/repo add tracked || fail "git add failed"
git -C /tmp/repo commit -m initial >/tmp/git.out 2>&1 ||
  fail "git commit failed: $(cat /tmp/git.out)"

printf 'modified\nstable\nadded\n' >/tmp/repo/tracked
(cd /tmp/repo && eza --color=never --git -l tracked) >/tmp/eza.out 2>/tmp/eza.err ||
  fail "eza git status failed: $(cat /tmp/eza.err)"
grep -q -- '-M.*tracked' /tmp/eza.out ||
  fail "eza omitted the modified Git-status field: $(cat /tmp/eza.out); $(cat /tmp/eza.err)"
git -C /tmp/repo checkout -- tracked || fail "restoring tracked fixture failed"

git -C /tmp/repo tag packed-tag || fail "creating packed tag failed"
git -C /tmp/repo gc >/tmp/git-gc.out 2>&1 ||
  fail "git gc failed: $(cat /tmp/git-gc.out)"
git -C /tmp/repo pack-refs --all || fail "packing refs failed"
git -C /tmp/repo commit-graph write --reachable ||
  fail "writing commit-graph failed"
test -f /tmp/repo/.git/packed-refs || fail "packed-refs fixture is missing"
test -f /tmp/repo/.git/objects/info/commit-graph ||
  fail "commit-graph fixture is missing"
set -- /tmp/repo/.git/objects/pack/*.pack
test -f "$1" || fail "packed object fixture is missing"

gix-file-probe /tmp/repo/.git >/tmp/gix-probe.out 2>/tmp/gix-probe.err ||
  fail "gix packed-ref/commitgraph probe failed: $(cat /tmp/gix-probe.err)"

printf 'modified\nstable\nadded\n' >/tmp/repo/tracked
bat --diff --color=never --style=changes --decorations=always \
  /tmp/repo/tracked >/tmp/bat-diff.out 2>/tmp/bat-diff.err ||
  fail "bat packed-object diff failed: $(cat /tmp/bat-diff.err)"
grep -q '^~.*modified' /tmp/bat-diff.out ||
  fail "bat omitted the modified marker: $(cat /tmp/bat-diff.out)"
grep -q '^+.*added' /tmp/bat-diff.out ||
  fail "bat omitted the added marker: $(cat /tmp/bat-diff.out)"

export _ZO_DATA_DIR=/tmp/zoxide
zoxide add /tmp/matrix || fail "zoxide add failed"
[ "$(zoxide query matrix)" = /tmp/matrix ] || fail "zoxide query did not return the added path"

btm --version >/tmp/btm.out || fail "bottom --version failed"
grep -q '^bottom ' /tmp/btm.out || fail "bottom version output was wrong: $(cat /tmp/btm.out)"

hyperfine --warmup 0 --runs 2 'coreutils true' >/tmp/hyperfine.out 2>/tmp/hyperfine.err ||
  fail "hyperfine child spawning failed: $(cat /tmp/hyperfine.err)"
grep -q 'Time' /tmp/hyperfine.out || fail "hyperfine produced no benchmark result"

cd /tmp/repo || fail "entering repository failed"
printf 'tracked\n' >/tmp/delta-old
printf 'changed\n' >/tmp/delta-new
delta --paging never /tmp/delta-old /tmp/delta-new >/tmp/delta.out 2>/tmp/delta.err
delta_status=$?
[ "$delta_status" -eq 1 ] ||
  fail "delta returned $delta_status: $(cat /tmp/delta.err)"
grep -q changed /tmp/delta.out ||
  fail "delta omitted the added line: $(cat /tmp/delta.out)"

dust -d 1 /tmp/matrix >/tmp/dust.out 2>/tmp/dust.err ||
  fail "dust failed: $(cat /tmp/dust.err)"
grep -q matrix /tmp/dust.out || fail "dust output was wrong: $(cat /tmp/dust.out)"

echo "::vm-test::pass"
while :; do :; done

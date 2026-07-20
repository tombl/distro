#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export GIT_EXEC_PATH=/libexec/git-core
export HOME=/root
export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.com

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mkdir -p /root /tmp
cd /tmp || fail "cd /tmp failed"

git init -b main repo >/dev/null 2>/tmp/e || fail "init: $(cat /tmp/e)"
cd repo || fail "cd repo failed"
git config user.name Test
git config user.email test@example.com

# Enough objects that packing and delta compression have something to chew on.
i=0
while [ "$i" -lt 24 ]; do
  {
    echo "file $i header"
    j=0
    while [ "$j" -lt 40 ]; do
      echo "shared body line $j so deltas across files are non-trivial"
      j=$((j + 1))
    done
    echo "file $i footer"
  } >"file$i.txt"
  git add "file$i.txt"
  git commit -m "commit $i" >/dev/null 2>/tmp/e || fail "commit $i: $(cat /tmp/e)"
  i=$((i + 1))
done

# --- cat-file round-trip through hash-object -w (writes a loose object) ---
printf 'roundtrip payload\nsecond line\n' >payload
oid=$(git hash-object -w payload) || fail "hash-object -w"
git cat-file -p "$oid" >payload.out || fail "cat-file -p"
cmp payload payload.out || fail "cat-file round-trip mismatch"
[ "$(git cat-file -t "$oid")" = blob ] || fail "cat-file -t not blob"

# --- threaded repack + zlib: collapse everything into a single pack ---
git config pack.threads 2
git repack -ad >/tmp/e 2>&1 || fail "repack -ad: $(cat /tmp/e)"
set -- .git/objects/pack/*.pack
[ -f "$1" ] || fail "no pack file after repack"
[ "$#" -eq 1 ] || fail "expected exactly 1 pack, got $# packs"

# --- fsck --strict validates the pack and full object connectivity ---
git fsck --strict >/tmp/e 2>&1 || fail "fsck --strict after repack: $(cat /tmp/e)"

# --- gc drives pack-objects and friends as spawned git subcommands ---
git gc >/tmp/e 2>&1 || fail "gc: $(cat /tmp/e)"
git fsck --strict >/tmp/e 2>&1 || fail "fsck --strict after gc: $(cat /tmp/e)"

# --- the packed history is still fully readable ---
c=$(git rev-list --count HEAD) || fail "rev-list --count"
[ "$c" -eq 24 ] || fail "expected 24 commits, got $c"
git rev-parse HEAD | grep -qE '^[0-9a-f]{40}$' || fail "rev-parse HEAD not a sha1"
git cat-file -p HEAD:file0.txt | grep -q 'file 0 header' || fail "read blob from pack"

echo "::vm-test::pass"
while :; do :; done

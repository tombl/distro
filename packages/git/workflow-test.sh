#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
# git resolves its own subcommands (repack -> pack-objects, hooks, ...) through
# this directory; the installed entries are symlinks to the git binary.
export GIT_EXEC_PATH=/libexec/git-core
export HOME=/root
# A committer identity without depending on any global config.
export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.com

# git opens /dev/null and spawns /bin/sh (posix_spawn) for hooks/pager, both of
# which need a populated /dev.
mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mkdir -p /root /tmp
cd /tmp || fail "cd /tmp failed"

# Prove the binary is ours.
git --version | grep -q '2.55.0' || fail "unexpected version: $(git --version)"

git init -b main repo >/dev/null 2>/tmp/e || fail "init: $(cat /tmp/e)"
cd repo || fail "cd repo failed"
git config user.name Test
git config user.email test@example.com

# --- add / commit / status / log ---
printf 'hello\n' >a.txt
printf 'world\n' >b.txt
git add a.txt b.txt || fail "add"
git commit -m "first commit" >/dev/null 2>/tmp/e || fail "commit: $(cat /tmp/e)"

st=$(git status --porcelain)
[ -z "$st" ] || fail "status not clean after commit: $st"
git log --format=%s | grep -qx "first commit" || fail "log missing commit subject"

# --- diff between edits ---
printf 'hello there\n' >a.txt
git diff -- a.txt | grep -q '^+hello there' || fail "diff missing added line"
git diff -- a.txt | grep -q '^-hello' || fail "diff missing removed line"
git commit -am "edit a" >/dev/null 2>/tmp/e || fail "commit edit: $(cat /tmp/e)"

# --- branch / checkout + fast-forward merge ---
git checkout -b feature >/dev/null 2>/tmp/e || fail "checkout -b feature: $(cat /tmp/e)"
printf 'feature line\n' >>b.txt
git commit -am "feature edit" >/dev/null 2>/tmp/e || fail "commit feature: $(cat /tmp/e)"
git checkout main >/dev/null 2>/tmp/e || fail "checkout main: $(cat /tmp/e)"
git merge --ff-only feature >/dev/null 2>/tmp/e || fail "fast-forward merge: $(cat /tmp/e)"
grep -q 'feature line' b.txt || fail "fast-forward merge did not update b.txt"

# --- real 3-way merge with a conflict, then resolve ---
git checkout -b branchX >/dev/null 2>/tmp/e || fail "checkout -b branchX: $(cat /tmp/e)"
printf 'X change\n' >c.txt
git add c.txt
git commit -m "add c on X" >/dev/null 2>/tmp/e || fail "commit c on X: $(cat /tmp/e)"
printf 'X to a\n' >a.txt
git commit -am "a on X" >/dev/null 2>/tmp/e || fail "commit a on X: $(cat /tmp/e)"

git checkout main >/dev/null 2>/tmp/e || fail "checkout main 2: $(cat /tmp/e)"
printf 'main to a\n' >a.txt
git commit -am "a on main" >/dev/null 2>/tmp/e || fail "commit a on main: $(cat /tmp/e)"

if git merge branchX >/tmp/m 2>&1; then
  fail "expected a merge conflict but merge succeeded"
fi
grep -q '^<<<<<<<' a.txt || fail "no conflict markers in a.txt"
# c.txt was added only on branchX; the 3-way merge should bring it in.
grep -q 'X change' c.txt || fail "3-way merge did not add c.txt"

printf 'resolved a\n' >a.txt
git add a.txt
git commit -m "merge branchX, conflict resolved" >/dev/null 2>/tmp/e ||
  fail "merge commit: $(cat /tmp/e)"
if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
  fail "MERGE_HEAD still present after merge commit"
fi

# --- tag + describe ---
git tag -a v1.0 -m "version 1.0" || fail "tag"
d=$(git describe --tags) || fail "describe failed"
case "$d" in
v1.0*) : ;;
*) fail "describe unexpected: $d" ;;
esac

# --- cat-file round-trip (plumbing) ---
oid=$(git rev-parse HEAD:a.txt) || fail "rev-parse blob"
git cat-file -p "$oid" >a.out || fail "cat-file -p"
[ "$(cat a.out)" = "resolved a" ] || fail "cat-file round-trip mismatch"
[ "$(git cat-file -t "$oid")" = blob ] || fail "cat-file -t not blob"

# --- a pre-commit hook must fire, proving child spawn via posix_spawn ---
mkdir -p .git/hooks
cat >.git/hooks/pre-commit <<'HOOK'
#!/bin/sh
echo hook-ran >/tmp/hook-marker
HOOK
chmod +x .git/hooks/pre-commit
rm -f /tmp/hook-marker
printf 'trigger\n' >d.txt
git add d.txt
git commit -m "commit that runs the hook" >/dev/null 2>/tmp/e ||
  fail "hook commit: $(cat /tmp/e)"
[ "$(cat /tmp/hook-marker 2>/dev/null)" = hook-ran ] ||
  fail "pre-commit hook did not run (posix_spawn child failed)"

# --- pager spawn: core.pager=cat, forced with --paginate, must complete ---
git -c core.pager=cat --paginate log --oneline >/tmp/paged 2>/tmp/e ||
  fail "paged log: $(cat /tmp/e)"
grep -q 'commit that runs the hook' /tmp/paged ||
  fail "pager (cat) produced no output"

echo "::vm-test::pass"
while :; do :; done

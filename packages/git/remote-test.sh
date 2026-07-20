#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export GIT_EXEC_PATH=/libexec/git-core
export HOME=/root
export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.com

# git spawns git-remote-http (posix_spawn) and it opens /dev/null.
mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc || fail "mounting proc failed"
mkdir -p /root /tmp
cd /tmp || fail "cd /tmp failed"

# git-remote-http is a standalone binary (not a builtin symlink): its presence
# proves libcurl linked. https/ftp/ftps are symlinks to it.
[ -e /libexec/git-core/git-remote-http ] || fail "git-remote-http not installed"
[ -e /libexec/git-core/git-remote-https ] || fail "git-remote-https not installed"

# Exercise the AF_UNIX credential cache. Git 2.55 starts the daemon as a fresh
# credential-cache--daemon executable through start_command()/posix_spawn; it
# does not use the historical fork-without-exec daemonization path.
git credential-cache --daemon >/tmp/cache-misuse.out 2>/tmp/cache-misuse.err
cache_misuse_rc=$?
[ "$cache_misuse_rc" -ne 0 ] || fail "credential-cache --daemon unexpectedly succeeded"
grep -q 'unknown option' /tmp/cache-misuse.err ||
  fail "credential-cache --daemon did not fail with a diagnostic: $(cat /tmp/cache-misuse.err)"

cache_socket=/tmp/git-credential-cache/socket
printf 'protocol=https\nhost=example.test\nusername=alice\npassword=secret\n\n' |
  git credential-cache --socket "$cache_socket" store 2>/tmp/err ||
  fail "credential-cache store failed: $(cat /tmp/err)"
cached=$(printf 'protocol=https\nhost=example.test\n\n' |
  git credential-cache --socket "$cache_socket" get 2>/tmp/err) ||
  fail "credential-cache get failed: $(cat /tmp/err)"
printf '%s\n' "$cached" | grep -qx 'username=alice' ||
  fail "credential-cache omitted username: [$cached]"
printf '%s\n' "$cached" | grep -qx 'password=secret' ||
  fail "credential-cache omitted password: [$cached]"
git credential-cache --socket "$cache_socket" exit 2>/tmp/err ||
  fail "credential-cache exit failed: $(cat /tmp/err)"
[ ! -e "$cache_socket" ] || fail "credential-cache exit left its socket behind"

# Build a real dumb-HTTP remote. This drives git -> git-remote-http -> libcurl ->
# BusyBox httpd over the guest TCP stack, then verifies both discovery and object
# transfer. A broad error-message grep against a deliberately closed port would
# pass even if the useful transport path were broken. The host VM deadline
# bounds hangs; every transport result is asserted below.
git init -b main source >/dev/null 2>/tmp/err || fail "init source: $(cat /tmp/err)"
git -C source config user.name Test
git -C source config user.email test@example.com
printf 'served over HTTP\n' >source/payload
git -C source add payload || fail "add source payload"
git -C source commit -m initial >/dev/null 2>/tmp/err || fail "commit source: $(cat /tmp/err)"
want=$(git -C source rev-parse HEAD) || fail "resolve source HEAD"

mkdir -p /srv || fail "create HTTP root"
git clone --bare source /srv/repo.git >/dev/null 2>/tmp/err || fail "create bare remote: $(cat /tmp/err)"
git --git-dir=/srv/repo.git update-server-info || fail "prepare dumb HTTP metadata"

ip link set lo up || fail "bringing up loopback failed"
httpd -f -p 127.0.0.1:18085 -h /srv &
httpd_pid=$!
attempts=0
while kill -0 "$httpd_pid" 2>/dev/null; do
  if awk '$2 ~ /:46A5$/ && $4 == "0A" { found = 1 } END { exit !found }' /proc/net/tcp; then
    break
  fi
  attempts=$((attempts + 1))
  [ "$attempts" -lt 100000 ] || fail "httpd did not publish its listening socket"
done
kill -0 "$httpd_pid" 2>/dev/null || fail "httpd exited before becoming ready"

remote=http://127.0.0.1:18085/repo.git
refs=$(git ls-remote "$remote" refs/heads/main 2>/tmp/err) ||
  fail "ls-remote over HTTP failed: $(cat /tmp/err)"
[ "$refs" = "$(printf '%s\trefs/heads/main' "$want")" ] ||
  fail "ls-remote returned [$refs]"

git clone --quiet "$remote" fetched 2>/tmp/err || fail "HTTP clone failed: $(cat /tmp/err)"
[ "$(cat fetched/payload)" = "served over HTTP" ] || fail "HTTP clone payload mismatch"
[ "$(git -C fetched rev-parse HEAD)" = "$want" ] || fail "HTTP clone HEAD mismatch"

kill "$httpd_pid" 2>/dev/null || :
wait "$httpd_pid" 2>/dev/null || :

echo "::vm-test::pass"
while :; do :; done

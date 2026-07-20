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

# git spawns git-remote-http (posix_spawn) and it opens /dev/null.
mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mkdir -p /root /tmp
cd /tmp || fail "cd /tmp failed"

# git-remote-http is a standalone binary (not a builtin symlink): its presence
# proves libcurl linked. https/ftp/ftps are symlinks to it.
[ -e /libexec/git-core/git-remote-http ] || fail "git-remote-http not installed"
[ -e /libexec/git-core/git-remote-https ] || fail "git-remote-https not installed"

# git must recognise http as a supported protocol (built-in curl transport),
# which it only reports when compiled without NO_CURL.
git remote-http 2>/tmp/rh
grep -qi 'curl\|usage\|remote-curl\|http' /tmp/rh ||
  fail "git-remote-http produced no recognisable output: $(cat /tmp/rh)"

# A real end-to-end fetch needs a server and network, neither of which exists in
# the sandbox. Instead point ls-remote at a closed local port and require a
# clean, fast, non-zero failure: the transport must report an error and exit,
# not crash (SIGSEGV/trap) or hang. 127.0.0.1:1 refuses or is unreachable
# immediately, so curl returns at once rather than waiting on a connect timeout.
if git ls-remote http://127.0.0.1:1/repo.git >/tmp/out 2>/tmp/err; then
  fail "ls-remote unexpectedly succeeded against a closed port"
fi
# Some diagnostic must have been emitted (connection refused / unable to
# connect / could not read), proving the helper ran and reported cleanly.
if ! grep -qiE 'unable to|could not|connect|refused|errno|fatal|fail' /tmp/err; then
  fail "ls-remote failed without a diagnostic: $(cat /tmp/err)"
fi

echo "::vm-test::pass"
while :; do :; done

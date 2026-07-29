#!/bin/busybox sh
# shellcheck disable=SC2016

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  printf '%s\n' "::vm-test::fail: $*"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export TERM=xterm

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mkdir -p /dev/pts || fail "creating /dev/pts failed"
mount -t devpts devpts /dev/pts || fail "mounting devpts failed"
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

[ -f /share/terminfo/x/xterm ] ||
  fail "Bash fragment did not ship xterm terminfo"

{
  printf '%s\n' 'case $- in *i*) printf "%s\n" interactive >/tmp/interactive ;; *) printf "%s\n" noninteractive >/tmp/interactive ;; esac'
  printf '%s\n' 'sleep 100 &'
  printf '%s\n' 'job_pid=$!'
  printf '%s\n' 'printf "%s\n" "$job_pid" >/tmp/job-pid'
  printf '%s\n' 'jobs -l'
  printf '%s\n' 'jobs -p >/tmp/jobs-before'
  printf '%s\n' 'kill %1'
  printf '%s\n' 'wait "$job_pid"'
  printf '%s\n' 'printf "%s\n" "$?" >/tmp/wait-status'
  printf '%s\n' 'jobs -p >/tmp/jobs-after'
  printf '%s\n' 'exit'
} >/tmp/bash-input

script -q -c '/bin/bash --noprofile --norc -i' /tmp/transcript \
  </tmp/bash-input >/tmp/script-output 2>&1 ||
  fail "PTY driver failed: $(cat /tmp/script-output)"

grep -qx interactive /tmp/interactive ||
  fail "Bash did not enter interactive mode: $(cat /tmp/interactive)"

job_pid=$(cat /tmp/job-pid) || fail "reading background job pid failed"
[ "$job_pid" -gt 1 ] || fail "invalid background job pid: $job_pid"
grep -qx "$job_pid" /tmp/jobs-before ||
  fail "jobs -p did not list $job_pid: $(cat /tmp/jobs-before)"
[ ! -s /tmp/jobs-after ] ||
  fail "killed job remains in jobs output: $(cat /tmp/jobs-after)"

wait_status=$(cat /tmp/wait-status) || fail "reading wait status failed"
[ "$wait_status" -eq 143 ] ||
  fail "waiting for killed job returned $wait_status, expected 143"

grep -q 'Running.*sleep 100' /tmp/transcript ||
  fail "jobs -l did not report the running sleep: $(cat /tmp/transcript)"

echo "::vm-test::pass"
while :; do :; done

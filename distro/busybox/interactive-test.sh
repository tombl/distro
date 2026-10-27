#!/bin/busybox sh
# shellcheck disable=SC2016

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export TERM=xterm

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mkdir -p /dev/pts || fail "creating /dev/pts failed"
mount -t devpts devpts /dev/pts || fail "mounting devpts failed"
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

# script gives the shell a controlling PTY, as setsid and cttyhack do for the
# site and runner consoles. Line editing recalls the previous command with the
# up arrow.
{
  printf '%s\n' 'printf "%s\n" "$-" >/tmp/flags'
  printf '%s\n' 'echo recalled >>/tmp/history'
  printf '\033[A\n'
  printf '%s\n' 'sleep 100 &'
  printf '%s\n' 'printf "%s\n" "$!" >/tmp/job-pid'
  printf '%s\n' 'jobs -l'
  printf '%s\n' 'jobs -p >/tmp/jobs-before'
  # Until the job execs sleep, it still ignores SIGTERM like the interactive
  # shell that forked it, and the kernel discards the kill. The shell can get
  # here first: it reads this input without blocking, so on one cpu the job
  # need not have run yet.
  printf '%s\n' 'until read -r _ comm _ </proc/$!/stat && [ "$comm" = "(sleep)" ]; do :; done'
  # One line: an interactive shell forgets a finished job once the next
  # prompt has reported it.
  printf '%s\n' 'kill %1; wait %1; printf "%s\n" "$?" >/tmp/wait-status'
  printf '%s\n' 'jobs -p >/tmp/jobs-after'
  printf '%s\n' '(sleep 1; echo foreground >/tmp/fg) &'
  printf '%s\n' 'fg %1'
  printf '%s\n' 'printf "%s\n" "$?" >/tmp/fg-status'
  printf '%s\n' 'exit'
} >/tmp/sh-input

script -q -c 'sh -i' /tmp/transcript \
  </tmp/sh-input >/tmp/script-output 2>&1 ||
  fail "PTY driver failed: $(cat /tmp/script-output)"

case $(cat /tmp/flags) in
*i*m* | *m*i*) ;;
*) fail "shell lacks interactive job control: flags $(cat /tmp/flags)" ;;
esac

[ "$(cat /tmp/history)" = "recalled
recalled" ] || fail "up arrow did not recall the command: $(cat /tmp/history)"

job_pid=$(cat /tmp/job-pid) || fail "reading background job pid failed"
[ "$job_pid" -gt 1 ] || fail "invalid background job pid: $job_pid"
grep -qx "$job_pid" /tmp/jobs-before ||
  fail "jobs -p did not list $job_pid: $(cat /tmp/jobs-before)"
[ ! -s /tmp/jobs-after ] ||
  fail "killed job remains in jobs output: $(cat /tmp/jobs-after)"
grep -q 'Running.*sleep 100' /tmp/transcript ||
  fail "jobs -l did not report the running sleep: $(cat /tmp/transcript)"

wait_status=$(cat /tmp/wait-status) || fail "reading wait status failed"
[ "$wait_status" -eq 143 ] ||
  fail "waiting for killed job returned $wait_status, expected 143"

[ "$(cat /tmp/fg)" = foreground ] || fail "fg job did not finish"
[ "$(cat /tmp/fg-status)" -eq 0 ] || fail "fg returned $(cat /tmp/fg-status)"

echo "::vm-test::pass"
while :; do :; done

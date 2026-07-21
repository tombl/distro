#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

bash --version >/tmp/bash-version 2>&1 ||
  fail "bash --version failed: $(cat /tmp/bash-version)"
grep -q 'GNU bash, version 5\.3' /tmp/bash-version ||
  fail "unexpected bash version: $(head -1 /tmp/bash-version)"

output=$(bash -c 'echo hi') || fail "bash -c exited nonzero"
[ "$output" = hi ] || fail "bash -c returned [$output], expected [hi]"

# Command substitution is the first make_child consumer converted to callback
# clone. Its child receives Bash's heap state but must not mutate the parent.
if ! bash -c 'x=1; y=$(x=2; echo inner); test "$x" = 1 && test "$y" = inner'; then
  fail "command substitution or parent-state isolation failed"
fi

if ! bash -c 'x=outer; (x=inner; test "$x" = inner); test "$x" = outer'; then
  fail "explicit subshell or parent-state isolation failed"
fi

if ! bash -c 'x=outer; (x=inner) & child=$!; wait "$child"; test "$x" = outer'; then
  fail "asynchronous explicit subshell failed"
fi

output=$(bash -c 'set -o pipefail; printf "pipeline\n" | cat') ||
  fail "builtin-to-external pipeline failed"
[ "$output" = pipeline ] || fail "pipeline returned [$output], expected [pipeline]"

if ! bash -c 'set -o pipefail; false | true; test $? -eq 1'; then
  fail "pipeline status or pipefail failed"
fi

if ! bash -c 'x=outer; x=inner & child=$!; wait "$child"; test "$x" = outer'; then
  fail "asynchronous simple command or isolation failed"
fi

output=$(bash -c '/bin/echo external') || fail "standalone external command failed"
[ "$output" = external ] ||
  fail "standalone external command returned [$output], expected [external]"

if ! bash -c 'command-that-does-not-exist; status=$?; test "$status" -eq 127' \
  >/tmp/not-found.out 2>&1; then
  fail "missing external command did not set status 127: $(cat /tmp/not-found.out)"
fi

if ! bash -c '/bin/false; status=$?; test "$status" -eq 1'; then
  fail "standalone failing external command lost its exit status"
fi

if ! bash -c 'value=expanded; read -r line <<EOF
$value
EOF
test "$line" = expanded'; then
  fail "expanded here-document failed"
fi

if ! bash -c 'read -r line <<<"here-string"; test "$line" = here-string'; then
  fail "here-string failed"
fi

if ! bash -c '< /dev/null'; then
  fail "forced-child redirection-only command failed"
fi

bash /tests/bash-functional-test.sh || fail "comprehensive Bash checks failed"

# The target has no dlopen, so loadable builtins must fail explicitly.
if bash -c 'enable -f /tmp/not-a-builtin.so example' >/tmp/loadable.out 2>&1; then
  fail "loading a dynamic builtin unexpectedly succeeded"
fi
grep -q 'dynamic loading not available' /tmp/loadable.out ||
  fail "loadable builtin failure was not explicit: $(cat /tmp/loadable.out)"

if ! bash -c 'test "$(cat <(printf process-substitution))" = process-substitution'; then
  fail "process substitution failed"
fi

if ! bash -c 'coproc child { read -r value; printf "reply:%s\n" "$value"; }; child_pid=$child_PID; printf "smoke\n" >&"${child[1]}"; read -r reply <&"${child[0]}"; wait "$child_pid" && test "$reply" = reply:smoke'; then
  fail "coprocess bidirectional I/O or PID variable failed"
fi

echo "::vm-test::pass"
while :; do :; done

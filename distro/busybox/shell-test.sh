#!/bin/busybox sh
# shellcheck disable=SC2016,SC2030,SC2031
# SC2016: the sh -c scripts expand in the child. SC2030/SC2031: subshells are
# expected not to change the parent.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

[ "$(readlink /bin/sh)" = busybox ] || fail "/bin/sh is not BusyBox"
sh -c 'set -o' | grep -q '^pipefail' || fail "/bin/sh is not ash"

# set -u: expanding an unset variable is a fatal error, a set one is not.
out=$(sh -c 'set -u; x=1; echo "$x"; echo "$unset_var"; echo after' 2>/tmp/err)
status=$?
[ "$status" -ne 0 ] || fail "set -u did not fail on an unset variable"
[ "$out" = 1 ] || fail "set -u printed [$out]"
grep -q unset_var /tmp/err || fail "set -u did not name the variable: $(cat /tmp/err)"
[ "$(sh -c 'set -u; echo "${unset_var-default}"')" = default ] ||
  fail "set -u rejected a defaulted expansion"

# set -e: a while condition that ends the loop is not a command failure.
cat >/tmp/errexit.sh <<'EOF'
set -e
i=0
while [ "$i" -lt 3 ]; do
  i=$((i + 1))
done
until [ "$i" -eq 0 ]; do
  i=$((i - 1))
done
if false; then :; fi
false || :
echo "loop-done $i"
false
echo unreachable
EOF
out=$(sh /tmp/errexit.sh)
status=$?
[ "$out" = "loop-done 0" ] || fail "set -e script printed [$out]"
[ "$status" -eq 1 ] || fail "set -e script exited $status instead of 1"

# Pipelines: data flows, the status is the last member's, pipefail works.
[ "$(printf 'b\na\nc\n' | sort | head -n 1)" = a ] || fail "pipeline failed"
false | true || fail "pipeline status was not the last member's"
sh -c 'set -o pipefail; false | true' && fail "pipefail ignored a failed member"
got=$(echo piped | while read -r line; do echo "got $line"; done)
[ "$got" = "got piped" ] || fail "pipeline into a loop gave [$got]"

# Command substitution, nested, with the parent's variables and functions.
greet() { echo "hello $1"; }
name=world
[ "$(greet "$name")" = "hello world" ] || fail "command substitution failed"
[ "$(greet "$(greet "$(greet nested)")")" = "hello hello hello nested" ] ||
  fail "nested substitution failed"
[ "$(sh -c 'echo `echo backquote`')" = backquote ] || fail "backquote substitution failed"
[ "$(sh -c 'echo $(exit 3; echo no)')" = "" ] || fail "exit in substitution leaked output"
sh -c 'x=$(exit 3)' && fail "substitution status was not propagated"

# Subshells see a copy of the parent and cannot modify it.
var=parent
(
  var=child
  cd /tmp || exit
  echo "$var" >/tmp/subshell
)
[ "$var" = parent ] || fail "subshell modified the parent variable"
[ "$(pwd)" = / ] || fail "subshell changed the parent directory"
[ "$(cat /tmp/subshell)" = child ] || fail "subshell did not run"
(exit 7)
status=$?
[ "$status" -eq 7 ] || fail "subshell exit status was $status, not 7"
missing=
unset missing
out=$(
  set -u
  echo "$missing"
  echo no
) 2>/dev/null && fail "error inside a subshell did not stop it: $out"
[ "$var" = parent ] || fail "subshell error leaked into the parent"

# Deep recursion inside a cloned child runs on the child stack.
depth() {
  [ "$1" -eq 0 ] && {
    echo bottom
    return
  }
  depth $(($1 - 1))
}
[ "$(depth 1000)" = bottom ] || fail "recursion in a subshell failed"

# Background jobs, $! and wait.
(
  sleep 1
  echo bg1 >/tmp/bg1
) &
pid1=$!
(exit 5) &
pid2=$!
wait "$pid2"
[ $? -eq 5 ] || fail "wait did not return the background job status"
wait "$pid1" || fail "wait for the sleeping job failed"
[ "$(cat /tmp/bg1)" = bg1 ] || fail "background job did not run"
sleep 30 &
kill $!
wait $!
[ $? -eq 143 ] || fail "wait for a killed job did not return 143"
for i in 1 2 3; do echo "$i" >"/tmp/job$i" & done
wait
[ "$(cat /tmp/job1 /tmp/job2 /tmp/job3 | tr -d '\n')" = 123 ] ||
  fail "wait without arguments missed jobs"

# Traps: EXIT, signals delivered to the shell, ERR, and reset in subshells.
[ "$(sh -c 'trap "echo bye" EXIT; echo hi')" = "hi
bye" ] || fail "EXIT trap did not run"
[ "$(sh -c 'trap "echo bye" EXIT; (echo sub)')" = "sub
bye" ] || fail "EXIT trap ran in a subshell"
[ "$(sh -c '(trap "echo sub-bye" EXIT; echo sub)')" = "sub
sub-bye" ] || fail "subshell EXIT trap did not run"
[ "$(sh -c 'trap "echo usr1" USR1; kill -USR1 $$; echo after')" = "usr1
after" ] || fail "USR1 trap did not run"
[ "$(sh -c 'trap "echo err" ERR; false; echo after')" = "err
after" ] || fail "ERR trap did not run"
trap 'echo trapped' USR2
[ "$(trap)" = "trap -- 'echo trapped' USR2" ] || fail "\$(trap) lost the parent's traps"
trap - USR2

# Here-documents, including one larger than a pipe buffer, which ash writes
# from a cloned child.
read -r here <<EOF
expanded $name
EOF
[ "$here" = "expanded world" ] || fail "here-document expansion failed"
[ "$(
  cat <<'EOF'
literal $name
EOF
)" = 'literal $name' ] || fail "quoted here-document was expanded"
big=$(awk 'BEGIN { for (i = 0; i < 2000; i++) print "line " i }')
lines=$(
  wc -l <<EOF
$big
EOF
)
[ "$lines" -eq 2000 ] || fail "large here-document had $lines lines"

# exec redirections persist in the shell and are inherited by children.
exec 3>/tmp/fd3
echo first >&3
(echo second >&3)
sh -c 'echo third >&3'
exec 3>&-
[ "$(tr '\n' ' ' </tmp/fd3)" = "first second third " ] ||
  fail "exec redirection gave [$(cat /tmp/fd3)]"
exec 4</tmp/fd3
read -r line <&4
[ "$line" = first ] || fail "exec input redirection read [$line]"
exec 4<&-
{ echo closed >&4; } 2>/dev/null && fail "closed descriptor was still writable"

# Each child reseeds $RANDOM rather than repeating the parent's sequence.
rand=$(sh -c 'a=$(echo $RANDOM) b=$(echo $RANDOM) c=$(echo $RANDOM); echo $a $b $c')
read -r r1 r2 r3 <<EOF
$rand
EOF
[ "$r1" = "$r2" ] && [ "$r2" = "$r3" ] && fail "\$RANDOM repeated in children: $rand"

echo "::vm-test::pass"
while :; do :; done

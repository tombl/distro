#!/bin/bash
# shellcheck disable=SC2030,SC2031

fail() {
  printf 'bash functional failure: %s\n' "$*" >&2
  exit 1
}

sum=0
for number in 1 2 3 4; do
  sum=$((sum + number))
done
[[ $sum -eq 10 ]] || fail "for loop or arithmetic expansion"

case_word=banana
case $case_word in
b*n*n*) case_result=matched ;;
*) case_result=missed ;;
esac
[[ $case_result == matched ]] || fail "case pattern"

counter=0
while [[ $counter -lt 3 ]]; do
  ((counter += 1))
done
[[ $counter -eq 3 ]] || fail "while loop or arithmetic command"

indexed=(zero one)
indexed[3]=three
[[ ${indexed[0]} == zero && ${indexed[3]} == three ]] || fail "indexed arrays"
[[ ${#indexed[@]} -eq 3 ]] || fail "sparse indexed array length"

declare -A associated=([alpha]=one [beta]=two)
[[ ${associated[alpha]} == one && ${associated[beta]} == two ]] ||
  fail "associative arrays"

conditional_value=foobar
[[ $conditional_value == f* && $conditional_value =~ ^foo ]] ||
  fail "extended conditional"

source_value=banana
[[ ${source_value//a/A} == bAnAnA ]] || fail "global parameter substitution"

printf -v formatted '%s:%02d' value 7
[[ $formatted == value:07 ]] || fail "printf -v"

function exercise_scope() {
  local local_value=inside
  declare -i declared_number=6
  declared_number+=1
  printf -v scoped_result '%s:%d' "$local_value" "$declared_number"
}

exercise_scope
[[ $scoped_result == inside:7 ]] || fail "function, local, or declare"
[[ ! -v local_value && ! -v declared_number ]] || fail "local variable leaked"

arithmetic_result=$((6 * 7))
[[ $arithmetic_result -eq 42 ]] || fail "arithmetic expansion"

# These assignments are intentionally isolated by two different child forms.
outer=parent
subshell_value=$(
  outer=command-substitution
  printf '%s' "$outer"
)
[[ $outer == parent && $subshell_value == command-substitution ]] ||
  fail "command substitution isolation"

nested=$(printf '%s' "$(printf '%s' "$(printf deep)")")
[[ $nested == deep ]] || fail "nested command substitution"

outer=parent
(
  outer=subshell
  [[ $outer == subshell ]]
) || fail "subshell execution"
[[ $outer == parent ]] || fail "subshell isolation"

pipeline_output=$(printf 'pipeline-data\n' | cat)
[[ $pipeline_output == pipeline-data ]] || fail "pipeline data flow"

/bin/false | /bin/true
pipeline_status=("${PIPESTATUS[@]}")
[[ ${pipeline_status[0]} -eq 1 && ${pipeline_status[1]} -eq 0 ]] ||
  fail "PIPESTATUS"

set -o pipefail
/bin/false | /bin/true
pipefail_status=$?
set +o pipefail
[[ $pipefail_status -eq 1 ]] || fail "pipefail status"

read -r heredoc_line <<EOF
expanded-$arithmetic_result
EOF
[[ $heredoc_line == expanded-42 ]] || fail "expanded here-document"

read -r herestring_line <<<"here-string"
[[ $herestring_line == here-string ]] || fail "here-string"

cat_output=$(
  cat <<'EOF'
external here-document
EOF
)
[[ $cat_output == "external here-document" ]] ||
  fail "here-document redirected to external command"

(
  trap 'printf "%s\n" exit-trap >/tmp/bash-exit-trap' EXIT
  :
)
read -r exit_trap_value </tmp/bash-exit-trap
[[ $exit_trap_value == exit-trap ]] || fail "EXIT trap"

usr1_value=pending
trap 'usr1_value=delivered' USR1
kill -USR1 "$$" &
signal_child=$!
wait "$signal_child"
signal_wait_status=$?
[[ $usr1_value == delivered ]] || fail "SIGUSR1 trap"
if [[ $signal_wait_status -gt 128 ]]; then
  wait "$signal_child" || fail "reaping SIGUSR1 sender after interrupted wait"
fi
trap - USR1

printf 'bash functional checks passed\n'

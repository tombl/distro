#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

assert_eq() {
  [ "$1" = "$2" ] || fail "$3: expected [$2], got [$1]"
}

# identity
out=$(printf '%s' '{"b":2,"a":1}' | jq -cS '.') ||
  fail "identity filter exited nonzero"
assert_eq "$out" '{"a":1,"b":2}' "identity"

# field access
out=$(printf '%s' '{"name":"bob","age":3}' | jq -r '.name') ||
  fail "field access exited nonzero"
assert_eq "$out" 'bob' "field access"

# map/select
out=$(printf '%s' '[1,2,3,4,5,6]' | jq -c 'map(select(. % 2 == 0))') ||
  fail "map/select exited nonzero"
assert_eq "$out" '[2,4,6]' "map/select"

# string interpolation
out=$(printf '%s' '{"who":"world","n":3}' | jq -r '"hello \(.who) x\(.n)"') ||
  fail "string interpolation exited nonzero"
assert_eq "$out" 'hello world x3' "string interpolation"

# pipeline of filters
out=$(printf '%s' '{"items":[{"v":10},{"v":20},{"v":30}]}' |
  jq -c '.items | map(.v) | add') ||
  fail "pipeline exited nonzero"
assert_eq "$out" '60' "pipeline"

# invalid JSON must be rejected with nonzero exit
printf '%s' '{"broken":' | jq '.' >/dev/null 2>&1
status=$?
[ "$status" -ne 0 ] || fail "invalid JSON was accepted (exit $status)"

echo "::vm-test::pass"
while :; do :; done

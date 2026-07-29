#!/bin/sh
# Exercises the non-spawning util-linux tools: every one runs at least once
# with its output asserted. The guest clock is 1970, so cal is given an
# explicit month/year.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

contains() {
  case "$1" in
  *"$2"*) return 0 ;;
  *) return 1 ;;
  esac
}

export PATH=/bin:/sbin:/gnu/bin:/usr/bin:/usr/sbin

# look() and namei() read from the filesystem; nothing here needs /dev, but
# mount it anyway so a stray tool that opens /dev/null does not trip.
mount -t devtmpfs devtmpfs /dev 2>/dev/null

# --- getopt: parse a canned spec --------------------------------------------
# Short -o "ab:c", long alpha/beta:, against a fixed argument vector. getopt
# normalises and quotes; assert the exact canonical string.
got=$(getopt -o ab:c --long alpha,beta: -- -a -b val --alpha foo)
exp=" -a -b 'val' --alpha -- 'foo'"
[ "$got" = "$exp" ] || fail "getopt: [$got] != [$exp]"

# --- column: -t aligns whitespace-separated fields --------------------------
coltxt=$(printf 'name age\nx 1\n' | column -t)
contains "$coltxt" "name  age" || fail "column header: $coltxt"
contains "$coltxt" "x     1" || fail "column row: $coltxt"

# --- hexdump: round-trip known bytes ----------------------------------------
hex=$(printf '\000\001\101\377' | hexdump -v -e '/1 "%02x"')
[ "$hex" = "000141ff" ] || fail "hexdump round-trip: $hex"

# --- rev --------------------------------------------------------------------
[ "$(echo hello | rev)" = "olleh" ] || fail "rev"

# --- colrm: drop columns 2..4 of 'abcdef' -> 'aef' --------------------------
[ "$(echo abcdef | colrm 2 4)" = "aef" ] || fail "colrm"

# --- look: prefix search in a sorted dictionary -----------------------------
printf 'apple\napply\nbanana\ncherry\n' >/tmp/words
looked=$(look app /tmp/words | tr '\n' ' ')
[ "$looked" = "apple apply " ] || fail "look: [$looked]"

# --- namei: report path components ------------------------------------------
mkdir -p /tmp/nd
echo x >/tmp/nd/leaf
nout=$(namei /tmp/nd/leaf)
contains "$nout" "f: /tmp/nd/leaf" || fail "namei header: $nout"
contains "$nout" "- leaf" || fail "namei leaf: $nout"
contains "$nout" "d tmp" || fail "namei dir: $nout"

# --- whereis: find a binary in an explicit dir ------------------------------
whereis_out=$(whereis -b -B /bin -f cal)
contains "$whereis_out" "/bin/cal" || fail "whereis: $whereis_out"

# --- cal: fixed month (July 2026) -------------------------------------------
caltxt=$(cal 7 2026)
contains "$caltxt" "July 2026" || fail "cal title: $caltxt"
contains "$caltxt" "31" || fail "cal grid: $caltxt"

# --- rename: substitute .txt -> .md -----------------------------------------
mkdir -p /tmp/rn
: >/tmp/rn/a.txt
: >/tmp/rn/b.txt
rename .txt .md /tmp/rn/a.txt /tmp/rn/b.txt || fail "rename exit"
[ -f /tmp/rn/a.md ] && [ -f /tmp/rn/b.md ] || fail "rename: target missing"
[ ! -e /tmp/rn/a.txt ] || fail "rename: source remains"

# --- uuidgen: two distinct v4 UUIDs -----------------------------------------
u1=$(uuidgen)
u2=$(uuidgen)
case "$u1" in
????????-????-4???-[89ab]???-????????????) ;;
*) fail "uuidgen not v4: $u1" ;;
esac
case "$u2" in
????????-????-4???-[89ab]???-????????????) ;;
*) fail "uuidgen not v4: $u2" ;;
esac
[ "$u1" != "$u2" ] || fail "uuidgen: two calls matched"

# --- uuidparse: classify that UUID as a random (v4) type --------------------
uuidparse_out=$(echo "$u1" | uuidparse)
case "$uuidparse_out" in
*"random"* | *"Random"*) ;;
*) fail "uuidparse: $uuidparse_out" ;;
esac

# --- mcookie: two distinct 128-bit hex cookies ------------------------------
m1=$(mcookie)
m2=$(mcookie)
[ "${#m1}" -eq 32 ] || fail "mcookie length: $m1"
case "$m1" in
*[!0-9a-f]*) fail "mcookie shape: $m1" ;;
esac
[ "$m1" != "$m2" ] || fail "mcookie: two calls matched"

# --- prlimit: read RLIMIT_NOFILE via prlimit64 + smartcols ------------------
prlimit_out=$(prlimit)
contains "$prlimit_out" NOFILE || fail "prlimit: $prlimit_out"

echo "::vm-test::pass"
while :; do :; done

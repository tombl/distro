#!/bin/busybox sh
# Exercises the non-spawning util-linux tools: every one runs at least once
# with its output asserted. The guest clock is 1970, so cal is given an
# explicit month/year.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

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
echo "$coltxt" | grep -qE '^name  *age$' || fail "column header: $coltxt"
echo "$coltxt" | grep -qE '^x  *1$' || fail "column row: $coltxt"

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
echo "$nout" | grep -qE '^f: /tmp/nd/leaf$' || fail "namei header: $nout"
echo "$nout" | grep -qE '[-] leaf$' || fail "namei leaf: $nout"
echo "$nout" | grep -qE 'd tmp$' || fail "namei dir: $nout"

# --- whereis: find a binary in an explicit dir ------------------------------
whereis -b -B /bin -f cal | grep -q '/bin/cal' || fail "whereis: $(whereis -b -B /bin -f cal)"

# --- cal: fixed month (July 2026) -------------------------------------------
caltxt=$(cal 7 2026)
echo "$caltxt" | grep -q 'July 2026' || fail "cal title: $caltxt"
echo "$caltxt" | grep -q '31' || fail "cal grid: $caltxt"

# --- rename: substitute .txt -> .md -----------------------------------------
mkdir -p /tmp/rn
: >/tmp/rn/a.txt
: >/tmp/rn/b.txt
rename .txt .md /tmp/rn/a.txt /tmp/rn/b.txt || fail "rename exit"
[ -f /tmp/rn/a.md ] && [ -f /tmp/rn/b.md ] || fail "rename: target missing"
[ ! -e /tmp/rn/a.txt ] || fail "rename: source remains"

# --- uuidgen: two distinct v4 UUIDs -----------------------------------------
v4='^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
u1=$(uuidgen)
u2=$(uuidgen)
echo "$u1" | grep -qE "$v4" || fail "uuidgen not v4: $u1"
echo "$u2" | grep -qE "$v4" || fail "uuidgen not v4: $u2"
[ "$u1" != "$u2" ] || fail "uuidgen: two calls matched"

# --- uuidparse: classify that UUID as a random (v4) type --------------------
echo "$u1" | uuidparse | grep -qi random || fail "uuidparse: $(echo "$u1" | uuidparse)"

# --- mcookie: two distinct 128-bit hex cookies ------------------------------
m1=$(mcookie)
m2=$(mcookie)
echo "$m1" | grep -qE '^[0-9a-f]{32}$' || fail "mcookie shape: $m1"
[ "$m1" != "$m2" ] || fail "mcookie: two calls matched"

# --- prlimit: read RLIMIT_NOFILE via prlimit64 + smartcols ------------------
prlimit | grep -q NOFILE || fail "prlimit: $(prlimit)"

echo "::vm-test::pass"
while :; do :; done

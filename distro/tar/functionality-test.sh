#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

# Tar's cloned children run compressors through /bin/sh and need a working
# /dev for their pipe endpoints.
mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
# BusyBox's no-MMU shell re-executes itself through /proc/self/exe when it
# starts commands, including the subshell GNU tar offers at a volume prompt.
mount -t proc proc /proc || fail "mounting proc failed"

# The remote transport deliberately retains upstream's privilege-reset path,
# whose getpwuid/initgroups calls require an NSS entry in this minimal guest.
mkdir -p /etc
printf 'root:x:0:0:root:/root:/bin/sh\n' >/etc/passwd
printf 'root:x:0:\n' >/etc/group

# Prove the GNU binary shadows busybox's tar applet.
tar --version | grep -q 'GNU tar' || fail "not running GNU tar"

# A small tree with known content to round-trip.
mkdir -p /tmp/src/dir
echo hello >/tmp/src/one.txt
echo world >/tmp/src/dir/two.txt
printf 'third file\n' >/tmp/src/dir/three.txt

# --- plain (uncompressed) create / list / extract round-trip ---
tar cf /tmp/plain.tar -C /tmp src || fail "create plain archive"

# The listing holds exactly the expected members.
out=$(tar tf /tmp/plain.tar | sort | tr '\n' ' ')
exp="src/ src/dir/ src/dir/three.txt src/dir/two.txt src/one.txt "
[ "$out" = "$exp" ] || fail "plain list: $out"

mkdir -p /tmp/out-plain
tar xf /tmp/plain.tar -C /tmp/out-plain || fail "extract plain archive"
[ "$(cat /tmp/out-plain/src/one.txt)" = "hello" ] || fail "plain one.txt content"
[ "$(cat /tmp/out-plain/src/dir/two.txt)" = "world" ] || fail "plain two.txt content"
cmp /tmp/src/dir/three.txt /tmp/out-plain/src/dir/three.txt || fail "plain three.txt cmp"

# --- compressor round-trips against regular-file archives ---
# For each: create (tar spawns the compressor to its stdout on the archive fd),
# confirm with the standalone decoder that the archive really is that stream
# wrapping a valid tar, then extract through tar (tar spawns the decompressor)
# and verify the extracted content byte-for-byte.
check_comp() {
  flag=$1
  ext=$2
  decoder=$3
  arc=/tmp/comp.$ext

  rm -f "$arc"
  tar "$flag" -cf "$arc" -C /tmp src || fail "$ext: create"

  # Standalone decoder proves a real <ext> stream that unwraps to a tar.
  $decoder <"$arc" >/tmp/decoded.tar 2>/dev/null || fail "$ext: standalone decode"
  tar tf /tmp/decoded.tar >/dev/null 2>&1 || fail "$ext: decoded payload is not a tar"

  # tar's own decompress path.
  rm -rf "/tmp/out-$ext"
  mkdir -p "/tmp/out-$ext"
  tar "$flag" -xf "$arc" -C "/tmp/out-$ext" || fail "$ext: extract"
  [ "$(cat "/tmp/out-$ext/src/one.txt")" = "hello" ] || fail "$ext: one.txt content"
  cmp /tmp/src/dir/three.txt "/tmp/out-$ext/src/dir/three.txt" || fail "$ext: three.txt cmp"
}

check_comp -z gz "gzip -dc"
check_comp -J xz "xz -dc"
check_comp --zstd zst "zstd -dc"
check_comp -j bz2 "bzip2 -dc"

mkfifo /tmp/compressor-status.fifo
cat </tmp/compressor-status.fifo >/dev/null &
status_reader=$!
tar --use-compress-program='exit 17' -cf /tmp/compressor-status.fifo \
  -C /tmp src >/dev/null 2>&1 && fail "reblock compressor status was ignored"
wait "$status_reader" || fail "status FIFO reader"

mkfifo /tmp/compressor-signal.fifo
cat </tmp/compressor-signal.fifo >/dev/null &
signal_reader=$!
tar --use-compress-program='kill -TERM $$' -cf /tmp/compressor-signal.fifo \
  -C /tmp src >/dev/null 2>&1 && fail "reblock compressor signal was ignored"
wait "$signal_reader" || fail "signal FIFO reader"

# Feed a complete, valid archive through stdin so each case necessarily uses
# tar's reblocking child and decompressor grandchild before that program fails.
# A one-block record avoids trailing record padding: tar intentionally ignores
# a decompressor's SIGPIPE after seeing the end markers, whereas these tests
# need the helper to reach its explicit failure after delivering EOF.
tar -b 1 -cf /tmp/plain-tight.tar -C /tmp src ||
  fail "prepare tightly blocked decompressor input"
cat >/tmp/decompress-exit.sh <<'EOF'
#!/bin/sh
cat
echo reached >/tmp/decompress-exit.reached
exit 19
EOF
chmod +x /tmp/decompress-exit.sh
rm -f /tmp/decompress-exit.list /tmp/decompress-exit.reached
tar --use-compress-program=/tmp/decompress-exit.sh -tf - \
  </tmp/plain-tight.tar \
  >/tmp/decompress-exit.list 2>/tmp/decompress-exit.err
decompress_status=$?
[ "$(cat /tmp/decompress-exit.reached)" = "reached" ] ||
  fail "nonzero decompressor did not reach its exit"
[ "$decompress_status" -ne 0 ] ||
  fail "reblock decompressor status was ignored"
grep -qx 'src/one.txt' /tmp/decompress-exit.list ||
  fail "nonzero decompressor did not emit the valid archive"

cat >/tmp/decompress-signal.sh <<'EOF'
#!/bin/sh
cat
echo reached >/tmp/decompress-signal.reached
kill -TERM $$
EOF
chmod +x /tmp/decompress-signal.sh
rm -f /tmp/decompress-signal.list /tmp/decompress-signal.reached
tar --use-compress-program=/tmp/decompress-signal.sh -tf - \
  </tmp/plain-tight.tar \
  >/tmp/decompress-signal.list 2>/tmp/decompress-signal.err
decompress_status=$?
[ "$(cat /tmp/decompress-signal.reached)" = "reached" ] ||
  fail "signaled decompressor did not reach its signal"
[ "$decompress_status" -ne 0 ] ||
  fail "reblock decompressor signal was ignored"
grep -qx 'src/one.txt' /tmp/decompress-signal.list ||
  fail "signaled decompressor did not emit the valid archive"

# Compressed standard streams retain tar's normal pipeline semantics.
tar -zcf - -C /tmp src >/tmp/stdout.tar.gz || fail "gzip: compressed stdout"
gzip -dc </tmp/stdout.tar.gz >/tmp/stdout.tar || fail "gzip: decode stdout archive"
tar tf /tmp/stdout.tar >/dev/null || fail "gzip: list stdout archive"

rm -rf /tmp/out-stdin
mkdir -p /tmp/out-stdin
gzip -c /tmp/plain.tar | tar -zxf - -C /tmp/out-stdin ||
  fail "gzip: compressed stdin"
cmp /tmp/src/one.txt /tmp/out-stdin/src/one.txt ||
  fail "gzip: compressed stdin content"

# A FIFO forces the compressor/decompressor reblocking topology.
mkfifo /tmp/archive-out.fifo
gzip -dc </tmp/archive-out.fifo >/tmp/fifo.tar &
fifo_reader=$!
tar -zcf /tmp/archive-out.fifo -C /tmp src || fail "gzip: create to FIFO"
wait "$fifo_reader" || fail "gzip: FIFO reader"
tar tf /tmp/fifo.tar >/dev/null || fail "gzip: list FIFO archive"

mkfifo /tmp/archive-in.fifo
gzip -c /tmp/plain.tar >/tmp/archive-in.fifo &
fifo_writer=$!
rm -rf /tmp/out-fifo
mkdir -p /tmp/out-fifo
tar -zxf /tmp/archive-in.fifo -C /tmp/out-fifo || fail "gzip: extract from FIFO"
wait "$fifo_writer" || fail "gzip: FIFO writer"
cmp /tmp/src/one.txt /tmp/out-fifo/src/one.txt ||
  fail "gzip: FIFO extract content"

# --to-command receives per-member state in its cloned child.  A checkpoint
# action executed later in the same tar process must not inherit that state.
cat >/tmp/to-command.sh <<'EOF'
#!/bin/sh
[ "$TAR_FILENAME" = "src/one.txt" ] || exit 41
[ "$TAR_FILETYPE" = "f" ] || exit 42
cat >/tmp/to-command.data
EOF
chmod +x /tmp/to-command.sh

cat >/tmp/checkpoint.sh <<'EOF'
#!/bin/sh
[ -z "${TAR_FILENAME+x}" ] || exit 51
[ -n "$TAR_CHECKPOINT" ] || exit 52
echo checkpoint-ok >/tmp/checkpoint.ok
EOF
chmod +x /tmp/checkpoint.sh

rm -f /tmp/checkpoint.ok /tmp/to-command.data
tar xf /tmp/plain.tar src/one.txt --to-command=/tmp/to-command.sh \
  --checkpoint=1 --checkpoint-action=exec=/tmp/checkpoint.sh ||
  fail "child environment scripts"
[ "$(cat /tmp/to-command.data)" = "hello" ] ||
  fail "to-command data"
[ "$(cat /tmp/checkpoint.ok)" = "checkpoint-ok" ] ||
  fail "checkpoint environment"

tar xf /tmp/plain.tar src/one.txt --to-command='exit 23' >/dev/null 2>&1 &&
  fail "to-command status was ignored"

# Multi-volume info scripts receive their state and reply descriptor only in
# the clone child.  A 32 KiB member crosses several 10 KiB volumes.
cat >/tmp/info-script.sh <<'EOF'
#!/bin/sh
[ -n "$TAR_VERSION" ] || exit 61
[ -n "$TAR_ARCHIVE" ] || exit 62
[ -n "$TAR_VOLUME" ] || exit 63
[ -n "$TAR_FD" ] || exit 64
eval "echo /tmp/volume-${TAR_VOLUME}.tar >&${TAR_FD}"
EOF
chmod +x /tmp/info-script.sh
dd if=/dev/zero of=/tmp/large.bin bs=1024 count=32 2>/dev/null ||
  fail "prepare multi-volume input"
rm -f /tmp/volume-*.tar
tar -cM -L 10 -f /tmp/volume-1.tar --info-script=/tmp/info-script.sh \
  -C /tmp large.bin || fail "multi-volume create"
rm -rf /tmp/out-volume
mkdir -p /tmp/out-volume
tar -xM -f /tmp/volume-1.tar --info-script=/tmp/info-script.sh \
  -C /tmp/out-volume || fail "multi-volume extract"
cmp /tmp/large.bin /tmp/out-volume/large.bin ||
  fail "multi-volume content"

# Without an info script, `!' at the volume-change prompt exercises
# sys_spawn_shell.  This non-reading shell helper writes a marker and exits, so
# tar can safely retain stdio read-ahead for the following `n' replies, which
# give each subsequent volume a fresh name.  Sixteen bounded replies are ample
# for this 32 KiB member.
cat >/tmp/volume-shell <<'EOF'
#!/bin/sh
echo spawned >/tmp/volume-shell.invoked
exit 0
EOF
chmod +x /tmp/volume-shell
rm -f /tmp/shell-volume-*.tar /tmp/volume-shell.invoked
{
  echo '!'
  volume=2
  while [ "$volume" -le 16 ]; do
    echo "n /tmp/shell-volume-${volume}.tar"
    volume=$((volume + 1))
  done
} | SHELL=/tmp/volume-shell \
  tar -cM -L 10 -f /tmp/shell-volume-1.tar -C /tmp large.bin \
  >/dev/null 2>&1 ||
  fail "multi-volume shell prompt"
[ "$(cat /tmp/volume-shell.invoked)" = "spawned" ] ||
  fail "multi-volume shell was not executed"
[ -f /tmp/shell-volume-2.tar ] ||
  fail "multi-volume shell test did not advance volumes"

# Exercise the rsh/rmt protocol locally, including compressed remote
# reblocking.  Its strict argv check proves the remote username survives the
# callback boundary and is passed with the traditional rsh `-l USER' shape.
cat >/tmp/fake-rsh <<'EOF'
#!/bin/sh
if [ "$#" -ne 4 ] || [ "$1" != "127.0.0.1" ] || [ "$2" != "-l" ] \
   || [ "$3" != "archive-user" ] || [ -z "$4" ]; then
  printf '%s\n' "$*" >/tmp/fake-rsh.bad-argv
  exit 71
fi
echo invoked >/tmp/fake-rsh.invoked
echo "$(id -u):$(id -g)" >/tmp/fake-rsh.ids
exec /libexec/rmt
EOF
chmod +x /tmp/fake-rsh
rm -f /tmp/remote.tar.gz /tmp/fake-rsh.invoked /tmp/fake-rsh.ids \
  /tmp/fake-rsh.bad-argv
tar --rsh-command /tmp/fake-rsh -zcf \
  archive-user@127.0.0.1:/tmp/remote.tar.gz -C /tmp src ||
  fail "compressed remote create"
[ "$(cat /tmp/fake-rsh.invoked)" = "invoked" ] || fail "remote transport not used"
[ "$(cat /tmp/fake-rsh.ids)" = "$(id -u):$(id -g)" ] ||
  fail "remote transport credentials"
rm -rf /tmp/out-remote
mkdir -p /tmp/out-remote
tar --rsh-command /tmp/fake-rsh -zxf \
  archive-user@127.0.0.1:/tmp/remote.tar.gz -C /tmp/out-remote ||
  fail "compressed remote extract"
cmp /tmp/src/dir/three.txt /tmp/out-remote/src/dir/three.txt ||
  fail "compressed remote content"

echo "::vm-test::pass"
while :; do :; done

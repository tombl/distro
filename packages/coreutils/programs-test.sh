#!/bin/sh
# Assert that the complete installed suite is present. The guest contains no
# BusyBox, so one version check establishes the provenance of the derivation;
# launching all 107 static wasm binaries would only retest identical version
# plumbing while retaining each process's emulator memory.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/gnu/bin:/bin:/sbin:/usr/bin:/usr/sbin

programs='
[ arch b2sum base32 base64 basename basenc cat chcon chgrp chmod chown
chroot cksum comm cp csplit cut date dd df dir dircolors dirname du echo env
expand expr factor false fmt fold groups head hostid hostname id install join
kill link ln logname ls md5sum mkdir mkfifo mknod mktemp mv nice nl nohup
nproc numfmt od paste pathchk pinky pr printenv printf ptx pwd readlink
realpath rm rmdir runcon seq sha1sum sha224sum sha256sum sha384sum sha512sum
shred shuf sleep sort split stat stty sum sync tac tail tee test timeout touch
tr true truncate tsort tty uname unexpand uniq unlink uptime users vdir wc who
whoami yes
'

for program in $programs; do
  [ -x "/gnu/bin/$program" ] || fail "$program is missing"
done

version=$(/gnu/bin/ls --version) || fail "ls --version failed"
case "$version" in
*"GNU coreutils"*) ;;
*) fail "suite did not identify as GNU coreutils: $version" ;;
esac

echo "::vm-test::pass"
while :; do :; done

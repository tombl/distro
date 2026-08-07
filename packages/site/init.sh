#!/bin/busybox sh

PATH=/bin:/sbin:/usr/bin:/usr/sbin

# The apk-installed busybox already carries its applet symlinks; no reinstall.

# The boot initramfs already moved a devtmpfs onto /dev before switch_root.
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mkdir -p /tmp /run /workspace
mount -t tmpfs tmpfs /tmp
mount -t tmpfs tmpfs /run
mount -t tmpfs tmpfs /workspace
chmod 01777 /tmp

# A name for the machine so the motd reads like a real host.
[ "$(hostname)" = "(none)" ] && hostname lowland

# The boot script passes the guest's network assignment and apk repository at
# boot, since they only exist once the page knows its own origin.
address=
gateway=
apk_repo=
# shellcheck disable=SC2013 # the kernel cmdline is deliberately word-split
for token in $(cat /proc/cmdline); do
  case "$token" in
  addr=*) address=${token#addr=} ;;
  gw=*) gateway=${token#gw=} ;;
  apkrepo=*) apk_repo=${token#apkrepo=} ;;
  esac
done

if [ -n "$address" ]; then
  /sbin/ifconfig eth0 "$address" netmask 255.255.255.0 up || echo "ifconfig failed: $?" >&2
  /sbin/route add default gw "$gateway" || echo "route failed: $?" >&2
fi
if [ -n "$apk_repo" ]; then
  # A .adb-suffixed repository line names the v3 index directly.
  printf '%s\n' "${apk_repo}/wasm32/Packages.adb" >/etc/apk/repositories
fi

# A neofetch-style motd. The apk line is the point: everything else on the
# page is a demo of what a whole installable machine in the browser can do.
kernel="$(uname -sr)"
arch="$(uname -m)"
cpus="$(grep -c '^processor' /proc/cpuinfo)"
uptime="$(awk '{ d=int($1/86400); h=int($1%86400/3600); m=int($1%3600/60); printf "%dd %dh %dm", d, h, m }' /proc/uptime)"
mem_total="$(awk '/MemTotal/ { printf "%.0f", $2/1024 }' /proc/meminfo)"
mem_avail="$(awk '/MemAvailable/ { printf "%.0f", $2/1024 }' /proc/meminfo)"

bold=$(printf '\033[1m')
label=$(printf '\033[1;34m')
reset=$(printf '\033[0m')

printf '%-14s%s\n' '    .--.' "${bold}root@$(hostname)${reset}"
printf '%-14s%s\n' '   |o_o |' "${label}os${reset}      ${kernel} ${arch}"
printf '%-14s%s\n' '   |:_/ |' "${label}uptime${reset}   ${uptime}"
# shellcheck disable=SC1003 # the art line ends in a literal backslash
printf '%-14s%s\n' '  //   \ \' "${label}cpus${reset}     ${cpus}"
printf '%-14s%s\n' ' (|     | )' "${label}memory${reset}   $((mem_total - mem_avail)) MiB / ${mem_total} MiB"
printf '%-14s%s\n' "/'\\_   _/\`\\" "${label}shell${reset}    sh"
printf '%-14s%s\n' '\___)=(___/' "${label}apk${reset}      add curl jq sqlite3, and more"
echo

exec setsid cttyhack sh

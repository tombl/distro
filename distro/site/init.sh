#!/bin/busybox sh

PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev
mount -t proc proc /proc
mount -t sysfs sysfs /sys

# A name for the machine so the motd reads like a real host.
[ "$(hostname)" = "(none)" ] && hostname lowland

# The host uses the guest package to own machine and network setup. Keep its
# agent beside the interactive console shell so spawnGuest can configure the
# interface and expose the normal exec/filesystem API without taking over PID 1.
/bin/linux-guest-agent &

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

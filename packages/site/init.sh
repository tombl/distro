#!/bin/busybox sh

PATH=/bin:/sbin:/usr/bin:/usr/sbin
export PATH

[ -c /dev/null ] || mount -t devtmpfs devtmpfs /dev
mount -t proc proc /proc
mount -t sysfs sysfs /sys

# Every page creates one private network, whose first guest is always .2.
# Configure it before the agent starts so boot does not depend on an agent
# process-spawn round trip.
/bin/busybox ifconfig lo up
/bin/busybox ifconfig eth0 192.0.2.2 netmask 255.255.255.0 up
/bin/busybox route add default gw 192.0.2.1 eth0

# A name for the machine so the motd reads like a real host.
[ "$(hostname)" = "(none)" ] && hostname lowland

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
echo "Run ${bold}install-lowland${reset} to install this machine locally."
echo

# The host uses the guest package to own machine and network setup. Start it
# after the MOTD helpers finish: wasm process creation is serialized, so this
# also avoids racing the host's first network-configuration exec.
/bin/linux-guest-agent &

exec setsid cttyhack sh

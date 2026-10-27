#!/bin/busybox sh

export PATH=/bin:/sbin

mount -t devtmpfs devtmpfs /dev || exit 1
mount -t proc proc /proc || exit 1
/vm-test-setup-dev-fd || exit 1
cmdline=" $(cat /proc/cmdline) "

case "$cmdline" in
*" lifecycle=pid1-exit "*)
  echo "lifecycle: exiting pid 1"
  exit 23
  ;;
*" lifecycle=panic "*)
  echo "lifecycle: triggering panic"
  echo c >/proc/sysrq-trigger
  ;;
*" lifecycle=poweroff "*)
  echo "lifecycle: powering off"
  exec /sbin/poweroff -f
  ;;
*" lifecycle=power "*)
  # An init without the agent: BusyBox's poweroff, halt and reboot signal
  # PID 1 with USR2, USR1 and TERM, as the kernel's power button does by
  # running /sbin/poweroff or /sbin/reboot.
  trap 'echo "lifecycle: powering off"; exec /sbin/poweroff -f' USR1 USR2
  trap 'echo "lifecycle: rebooting"; exec /sbin/reboot -f' TERM
  echo "lifecycle: waiting for power"
  while :; do
    sleep 1000 &
    wait $!
  done
  ;;
*" lifecycle=reboot "*)
  echo "lifecycle: rebooting"
  exec /sbin/reboot -f
  ;;
*" lifecycle=network "*)
  # The kernel configured the network from ip= before this ran.
  echo "lifecycle: network"
  echo "hostname: $(hostname)"
  cat /proc/net/pnp
  ifconfig eth0
  route -n
  exec /sbin/poweroff -f
  ;;
*" lifecycle=multi-cpu-panic "*)
  echo "lifecycle: starting work on multiple cpus"
  i=0
  while [ "$i" -lt 8 ]; do
    sh -c 'while :; do :; done' &
    i=$((i + 1))
  done
  sleep 0.1
  echo "lifecycle: triggering panic"
  echo c >/proc/sysrq-trigger
  ;;
esac

echo "lifecycle: unknown mode: $cmdline" >&2
exit 127

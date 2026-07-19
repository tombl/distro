#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

ip link set lo up || fail "bringing up loopback failed"

mkdir -p /tmp/www || fail "creating document root failed"
printf '%s\n' network-content >/tmp/www/index.html || fail "creating HTTP fixture failed"
httpd -f -p 127.0.0.1:18080 -h /tmp/www &
httpd_pid=$!
sleep 0.1

wget -q -O /tmp/download http://127.0.0.1:18080/index.html ||
  fail "wget failed to fetch from httpd"
grep -qx network-content /tmp/download || fail "wget downloaded the wrong content"

printf 'GET /index.html HTTP/1.0\r\n\r\n' | nc -w 2 127.0.0.1 18080 >/tmp/http-response ||
  fail "nc failed to connect to httpd"
grep -q network-content /tmp/http-response || fail "nc did not receive the HTTP response"

kill "$httpd_pid" 2>/dev/null || :
wait "$httpd_pid" 2>/dev/null || :

mkdir -p /tmp/ftp || fail "creating FTP root failed"
printf '%s\n' listing-content >/tmp/ftp/listing-file || fail "creating FTP fixture failed"
tcpsvd 127.0.0.1 18083 ftpd /tmp/ftp &
ftpd_pid=$!
nc -l -p 18084 >/tmp/ftp-listing &
ftp_data_pid=$!
sleep 0.1
printf 'USER anonymous\r\nPASS guest\r\nPORT 127,0,0,1,70,164\r\nLIST\r\nQUIT\r\n' |
  nc -w 2 127.0.0.1 18083 >/tmp/ftp-control || fail "FTP control connection failed"
wait "$ftp_data_pid" || fail "FTP data connection failed"
grep -q listing-file /tmp/ftp-listing || fail "ftpd returned an empty directory listing"
kill "$ftpd_pid" 2>/dev/null || :
wait "$ftpd_pid" 2>/dev/null || :

tcpsvd 127.0.0.1 18081 /bin/echo tcp-service &
tcpsvd_pid=$!
sleep 0.1
nc -w 2 127.0.0.1 18081 </dev/null >/tmp/tcp-service-response ||
  fail "nc failed to connect to tcpsvd"
grep -qx tcp-service /tmp/tcp-service-response || fail "tcpsvd did not run its service"
kill "$tcpsvd_pid" 2>/dev/null || :
wait "$tcpsvd_pid" 2>/dev/null || :

udpsvd 127.0.0.1 18082 /bin/echo udp-service &
udpsvd_pid=$!
sleep 0.1
printf '%s\n' request | nc -u -w 1 127.0.0.1 18082 >/tmp/udp-service-response ||
  fail "nc failed to connect to udpsvd"
grep -qx udp-service /tmp/udp-service-response || fail "udpsvd did not run its service"
kill "$udpsvd_pid" 2>/dev/null || :
wait "$udpsvd_pid" 2>/dev/null || :

echo "::vm-test::pass"
while :; do :; done

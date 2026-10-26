// Copyright 2026 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

//go:build linux && wasm

package unix_test

import (
	"bytes"
	"encoding/binary"
	"os"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// The wasm32 kernel takes 32-bit argument slots and has the asm-generic
// 32-bit entries, while Go's types on linux/wasm have musl's time64 layout and
// 64-bit pointers. These tests check the values crossing that boundary, not
// only that the calls succeed.

const _ = unix.SYS_FUTEX_TIME64

func near(t *testing.T, name string, got, want time.Time) {
	t.Helper()
	if d := got.Sub(want); d < -10*time.Second || d > 10*time.Second {
		t.Errorf("%s = %v; want about %v", name, got, want)
	}
}

func atLeast(t *testing.T, name string, start time.Time, want time.Duration) {
	t.Helper()
	if d := time.Since(start); d < want || d > want+5*time.Second {
		t.Errorf("%s returned after %v; want %v", name, d, want)
	}
}

func TestWasmABIFileOffsets(t *testing.T) {
	f, err := os.Create(t.TempDir() + "/offsets")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	fd := int(f.Fd())

	if _, err := unix.Write(fd, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	if off, err := unix.Seek(fd, 0, unix.SEEK_CUR); err != nil || off != 5 {
		t.Errorf("Seek(0, SEEK_CUR) = %d, %v; want 5", off, err)
	}
	if off, err := unix.Seek(fd, 2, unix.SEEK_SET); err != nil || off != 2 {
		t.Errorf("Seek(2, SEEK_SET) = %d, %v; want 2", off, err)
	}

	const big = 5 << 30
	if err := unix.Ftruncate(fd, big); err != nil {
		t.Fatal(err)
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil || st.Size != big {
		t.Errorf("size after Ftruncate(%d) = %d, %v", int64(big), st.Size, err)
	}
	if off, err := unix.Seek(fd, 0, unix.SEEK_END); err != nil || off != big {
		t.Errorf("Seek(0, SEEK_END) = %d, %v; want %d", off, err, int64(big))
	}
	if err := unix.Truncate(f.Name(), big+1); err != nil {
		t.Fatal(err)
	}
	if err := unix.Stat(f.Name(), &st); err != nil || st.Size != big+1 {
		t.Errorf("size after Truncate(%d) = %d, %v", int64(big+1), st.Size, err)
	}

	const far = 6 << 30
	if n, err := unix.Pwrite(fd, []byte("x"), far); err != nil || n != 1 {
		t.Fatalf("Pwrite(%d) = %d, %v", int64(far), n, err)
	}
	if err := unix.Fstat(fd, &st); err != nil || st.Size != far+1 {
		t.Errorf("size after Pwrite(%d) = %d, %v", int64(far), st.Size, err)
	}
	buf := make([]byte, 1)
	if n, err := unix.Pread(fd, buf, far); err != nil || n != 1 || buf[0] != 'x' {
		t.Errorf("Pread(%d) = %d, %q, %v", int64(far), n, buf, err)
	}

	if err := unix.Ftruncate(fd, 0); err != nil {
		t.Fatal(err)
	}
	if err := unix.Fallocate(fd, 0, 4096, 4096); err == unix.EOPNOTSUPP {
		t.Log("Fallocate: not supported by this filesystem")
	} else if err != nil {
		t.Errorf("Fallocate: %v", err)
	} else if err := unix.Fstat(fd, &st); err != nil || st.Size != 8192 {
		t.Errorf("size after Fallocate(4096, 4096) = %d, %v; want 8192", st.Size, err)
	}
	if err := unix.Fadvise(fd, 0, 8192, unix.FADV_SEQUENTIAL); err != nil {
		t.Errorf("Fadvise: %v", err)
	}
	if err := unix.SyncFileRange(fd, 0, 4096, unix.SYNC_FILE_RANGE_WRITE); err != nil {
		t.Errorf("SyncFileRange: %v", err)
	}
	// Invalid flags must reach the kernel as flags, not as part of the range.
	if err := unix.SyncFileRange(fd, 0, 4096, 0x80); err != unix.EINVAL {
		t.Errorf("SyncFileRange with invalid flags = %v; want EINVAL", err)
	}
	if err := unix.Fadvise(fd, 0, 8192, 12345); err != unix.EINVAL {
		t.Errorf("Fadvise with an invalid advice = %v; want EINVAL", err)
	}

	var fs unix.Statfs_t
	if err := unix.Fstatfs(fd, &fs); err != nil || fs.Bsize <= 0 || fs.Blocks == 0 {
		t.Errorf("Fstatfs = %+v, %v", fs, err)
	}
	if err := unix.Statfs(f.Name(), &fs); err != nil || fs.Bsize <= 0 || fs.Blocks == 0 {
		t.Errorf("Statfs = %+v, %v", fs, err)
	}
}

func TestWasmABIStatTimes(t *testing.T) {
	now := time.Now()
	path := t.TempDir() + "/times"
	if err := os.WriteFile(path, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	var st unix.Stat_t
	if err := unix.Lstat(path, &st); err != nil {
		t.Fatal(err)
	}
	if st.Size != 5 || st.Mode&unix.S_IFMT != unix.S_IFREG || st.Nlink != 1 {
		t.Errorf("Lstat = %+v", st)
	}
	near(t, "Lstat Mtim", time.Unix(st.Mtim.Unix()), now)

	atime := unix.NsecToTimespec(time.Unix(100, 10).UnixNano())
	mtime := unix.NsecToTimespec(time.Unix(200, 20).UnixNano())
	if err := unix.UtimesNano(path, []unix.Timespec{atime, mtime}); err != nil {
		t.Fatal(err)
	}
	if err := unix.Stat(path, &st); err != nil {
		t.Fatal(err)
	}
	if st.Atim != atime || st.Mtim != mtime {
		t.Errorf("times after UtimesNano = %+v, %+v; want %+v, %+v", st.Atim, st.Mtim, atime, mtime)
	}

	tv := []unix.Timeval{{Sec: 300, Usec: 3}, {Sec: 400, Usec: 4}}
	if err := unix.Utimes(path, tv); err != nil {
		t.Fatal(err)
	}
	if err := unix.Stat(path, &st); err != nil {
		t.Fatal(err)
	}
	if st.Atim.Sec != 300 || st.Atim.Nsec != 3000 || st.Mtim.Sec != 400 || st.Mtim.Nsec != 4000 {
		t.Errorf("times after Utimes = %+v, %+v", st.Atim, st.Mtim)
	}
}

func TestWasmABIClocks(t *testing.T) {
	now := time.Now()

	var ts unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_REALTIME, &ts); err != nil {
		t.Fatal(err)
	}
	if ts.Nsec < 0 || ts.Nsec >= 1e9 {
		t.Errorf("ClockGettime Nsec = %d", ts.Nsec)
	}
	near(t, "ClockGettime", time.Unix(ts.Unix()), now)
	if err := unix.ClockGetres(unix.CLOCK_MONOTONIC, &ts); err != nil || ts.Sec != 0 || ts.Nsec <= 0 || ts.Nsec > 1e7 {
		t.Errorf("ClockGetres = %+v, %v", ts, err)
	}

	var tv unix.Timeval
	if err := unix.Gettimeofday(&tv); err != nil {
		t.Fatal(err)
	}
	if tv.Usec < 0 || tv.Usec >= 1e6 {
		t.Errorf("Gettimeofday Usec = %d", tv.Usec)
	}
	near(t, "Gettimeofday", time.Unix(tv.Unix()), now)
	// An invalid timeval must be rejected, not truncated into a valid time.
	if err := unix.Settimeofday(&unix.Timeval{Sec: tv.Sec, Usec: 1 << 32}); err != unix.EINVAL {
		t.Errorf("Settimeofday with Usec 1<<32 = %v; want EINVAL", err)
	}
	if sec, err := unix.Time(nil); err != nil {
		t.Fatal(err)
	} else {
		near(t, "Time", time.Unix(int64(sec), 0), now)
	}

	sleep := unix.NsecToTimespec(int64(150 * time.Millisecond))
	start := time.Now()
	if err := unix.Nanosleep(&sleep, nil); err != nil {
		t.Fatal(err)
	}
	atLeast(t, "Nanosleep(150ms)", start, 150*time.Millisecond)
	start = time.Now()
	if err := unix.ClockNanosleep(unix.CLOCK_MONOTONIC, 0, &sleep, nil); err != nil {
		t.Fatal(err)
	}
	atLeast(t, "ClockNanosleep(150ms)", start, 150*time.Millisecond)

	var tx unix.Timex
	if _, err := unix.Adjtimex(&tx); err != nil {
		t.Fatal(err)
	}
	if tx.Tick <= 0 || tx.Time.Usec < 0 || tx.Time.Usec >= 1e9 {
		t.Errorf("Adjtimex = %+v", tx)
	}
	near(t, "Adjtimex Time", time.Unix(tx.Time.Sec, 0), now)
}

func TestWasmABITimers(t *testing.T) {
	fd, err := unix.TimerfdCreate(unix.CLOCK_MONOTONIC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	spec := unix.ItimerSpec{
		Interval: unix.NsecToTimespec(int64(20 * time.Millisecond)),
		Value:    unix.NsecToTimespec(int64(50 * time.Millisecond)),
	}
	if err := unix.TimerfdSettime(fd, 0, &spec, nil); err != nil {
		t.Fatal(err)
	}
	var cur unix.ItimerSpec
	if err := unix.TimerfdGettime(fd, &cur); err != nil {
		t.Fatal(err)
	}
	if cur.Interval != spec.Interval || cur.Value.Sec != 0 || cur.Value.Nsec <= 0 || cur.Value.Nsec > spec.Value.Nsec {
		t.Errorf("TimerfdGettime = %+v; want interval %+v and value at most %+v", cur, spec.Interval, spec.Value)
	}
	time.Sleep(200 * time.Millisecond)
	buf := make([]byte, 8)
	if n, err := unix.Read(fd, buf); err != nil || n != 8 {
		t.Fatalf("timerfd read = %d, %v", n, err)
	}
	if count := binary.LittleEndian.Uint64(buf); count < 2 || count > 20 {
		t.Errorf("timerfd expirations after 200ms = %d; want several", count)
	}

	// The kernel's itimerval holds 32-bit timevals: an unrepresentable time
	// must be rejected rather than truncated, which could disarm the timer.
	if _, err := unix.Setitimer(unix.ItimerReal, unix.Itimerval{Value: unix.Timeval{Sec: 1 << 32}}); err != unix.EINVAL {
		t.Errorf("Setitimer(1<<32 s) = %v; want EINVAL", err)
	}

	value := unix.Itimerval{Value: unix.Timeval{Sec: 30, Usec: 500000}}
	if _, err := unix.Setitimer(unix.ItimerReal, value); err != nil {
		t.Fatal(err)
	}
	got, err := unix.Getitimer(unix.ItimerReal)
	unix.Setitimer(unix.ItimerReal, unix.Itimerval{})
	if err != nil {
		t.Fatal(err)
	}
	if got.Interval != (unix.Timeval{}) || got.Value.Sec < 25 || got.Value.Sec > 30 || got.Value.Usec < 0 || got.Value.Usec >= 1e6 {
		t.Errorf("Getitimer = %+v; want about %+v", got, value)
	}
}

func TestWasmABIPolling(t *testing.T) {
	timeout := unix.NsecToTimespec(int64(100 * time.Millisecond))
	start := time.Now()
	if n, err := unix.Ppoll(nil, &timeout, nil); err != nil || n != 0 {
		t.Errorf("Ppoll = %d, %v", n, err)
	}
	atLeast(t, "Ppoll(100ms)", start, 100*time.Millisecond)

	var mask unix.Sigset_t
	timeout = unix.NsecToTimespec(int64(100 * time.Millisecond))
	start = time.Now()
	if n, err := unix.Ppoll(nil, &timeout, &mask); err != nil || n != 0 {
		t.Errorf("Ppoll with a signal mask = %d, %v", n, err)
	}
	atLeast(t, "Ppoll(100ms) with a signal mask", start, 100*time.Millisecond)

	tv := unix.NsecToTimeval(int64(100 * time.Millisecond))
	start = time.Now()
	if n, err := unix.Select(0, nil, nil, nil, &tv); err != nil || n != 0 {
		t.Errorf("Select = %d, %v", n, err)
	}
	atLeast(t, "Select(100ms)", start, 100*time.Millisecond)

	// ppoll stored the remaining time, zero, back into timeout.
	timeout = unix.NsecToTimespec(int64(100 * time.Millisecond))
	start = time.Now()
	if n, err := unix.Pselect(0, nil, nil, nil, &timeout, &mask); err != nil || n != 0 {
		t.Errorf("Pselect with a signal mask = %d, %v", n, err)
	}
	atLeast(t, "Pselect(100ms)", start, 100*time.Millisecond)
}

func TestWasmABIRusage(t *testing.T) {
	for deadline := time.Now().Add(50 * time.Millisecond); time.Now().Before(deadline); {
	}
	var ru unix.Rusage
	if err := unix.Getrusage(unix.RUSAGE_SELF, &ru); err != nil {
		t.Fatal(err)
	}
	checkRusage(t, "Getrusage", &ru, true)

	for _, waitid := range []bool{false, true} {
		p, err := os.StartProcess("/bin/sh", []string{"sh", "-c", "i=0; while [ $i -lt 2000 ]; do i=$((i+1)); done; exit 7"}, &os.ProcAttr{})
		if err != nil {
			t.Fatal(err)
		}
		var ru unix.Rusage
		if waitid {
			var info unix.Siginfo
			if err := unix.Waitid(unix.P_PID, p.Pid, &info, unix.WEXITED, &ru); err != nil {
				t.Fatal(err)
			}
			checkRusage(t, "Waitid", &ru, false)
		} else {
			var ws unix.WaitStatus
			if pid, err := unix.Wait4(p.Pid, &ws, 0, &ru); err != nil || pid != p.Pid {
				t.Fatalf("Wait4 = %d, %v", pid, err)
			}
			if !ws.Exited() || ws.ExitStatus() != 7 {
				t.Errorf("Wait4 status = %#x; want exit 7", ws)
			}
			checkRusage(t, "Wait4", &ru, false)
		}
	}
}

func checkRusage(t *testing.T, name string, ru *unix.Rusage, busy bool) {
	t.Helper()
	cpu := time.Duration(unix.TimevalToNsec(ru.Utime) + unix.TimevalToNsec(ru.Stime))
	if ru.Utime.Usec < 0 || ru.Utime.Usec >= 1e6 || ru.Stime.Usec < 0 || ru.Stime.Usec >= 1e6 ||
		cpu < 0 || cpu > time.Hour || (busy && cpu == 0) || ru.Maxrss < 0 || ru.Nvcsw+ru.Nivcsw <= 0 {
		t.Errorf("%s rusage = %+v", name, ru)
	}
}

func socketpair(t *testing.T, typ int) (int, int) {
	t.Helper()
	fds, err := unix.Socketpair(unix.AF_UNIX, typ, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		unix.Close(fds[0])
		unix.Close(fds[1])
	})
	return fds[0], fds[1]
}

// recvTimesOut reports whether a receive on fd with a 150ms SO_RCVTIMEO
// returns EAGAIN after the timeout rather than data.
func recvTimesOut(t *testing.T, fd int) bool {
	t.Helper()
	tv := unix.NsecToTimeval(int64(150 * time.Millisecond))
	if err := unix.SetsockoptTimeval(fd, unix.SOL_SOCKET, unix.SO_RCVTIMEO, &tv); err != nil {
		t.Fatal(err)
	}
	got, err := unix.GetsockoptTimeval(fd, unix.SOL_SOCKET, unix.SO_RCVTIMEO)
	if err != nil || *got != tv {
		t.Errorf("GetsockoptTimeval(SO_RCVTIMEO) = %+v, %v; want %+v", got, err, tv)
	}
	done := make(chan error, 1)
	start := time.Now()
	go func() {
		_, _, err := unix.Recvfrom(fd, make([]byte, 16), 0)
		done <- err
	}()
	select {
	case err := <-done:
		if err == unix.EAGAIN {
			atLeast(t, "Recvfrom with SO_RCVTIMEO", start, 100*time.Millisecond)
			return true
		}
		if err != nil {
			t.Errorf("Recvfrom = %v", err)
		}
		return false
	case <-time.After(10 * time.Second):
		t.Fatal("Recvfrom with a 150ms SO_RCVTIMEO still blocked after 10s")
		return false
	}
}

func TestWasmABISocketTimeout(t *testing.T) {
	a, _ := socketpair(t, unix.SOCK_DGRAM)
	if !recvTimesOut(t, a) {
		t.Error("Recvfrom with SO_RCVTIMEO did not time out")
	}
}

func TestWasmABIMessages(t *testing.T) {
	a, b := socketpair(t, unix.SOCK_DGRAM)

	f, err := os.Open("/")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	rights := unix.UnixRights(int(f.Fd()))
	n, err := unix.SendmsgBuffers(a, [][]byte{[]byte("ab"), []byte("cdef")}, rights, nil, 0)
	if err != nil || n != 6 {
		t.Fatalf("SendmsgBuffers = %d, %v", n, err)
	}
	bufs := [][]byte{make([]byte, 1), make([]byte, 8)}
	oob := make([]byte, unix.CmsgSpace(4))
	n, oobn, flags, _, err := unix.RecvmsgBuffers(b, bufs, oob, 0)
	if err != nil || n != 6 || flags != 0 {
		t.Fatalf("RecvmsgBuffers = %d, %d, %#x, %v", n, oobn, flags, err)
	}
	if got := string(bufs[0]) + string(bufs[1][:5]); got != "abcdef" {
		t.Errorf("RecvmsgBuffers data = %q; want %q", got, "abcdef")
	}
	msgs, err := unix.ParseSocketControlMessage(oob[:oobn])
	if err != nil || len(msgs) != 1 {
		t.Fatalf("ParseSocketControlMessage = %v, %v", msgs, err)
	}
	fds, err := unix.ParseUnixRights(&msgs[0])
	if err != nil || len(fds) != 1 {
		t.Fatalf("ParseUnixRights = %v, %v", fds, err)
	}
	defer unix.Close(fds[0])
	var st1, st2 unix.Stat_t
	if err := unix.Fstat(fds[0], &st1); err != nil {
		t.Fatal(err)
	}
	if err := unix.Fstat(int(f.Fd()), &st2); err != nil {
		t.Fatal(err)
	}
	if st1.Ino != st2.Ino || st1.Dev != st2.Dev {
		t.Errorf("received descriptor is %d:%d; want %d:%d", st1.Dev, st1.Ino, st2.Dev, st2.Ino)
	}
}

func TestWasmABIVmsplice(t *testing.T) {
	var p [2]int
	if err := unix.Pipe(p[:]); err != nil {
		t.Fatal(err)
	}
	defer unix.Close(p[0])
	defer unix.Close(p[1])
	data := []byte("hello")
	iov := []unix.Iovec{{Base: &data[0]}}
	iov[0].SetLen(len(data))
	n, err := unix.Vmsplice(p[1], iov, 0)
	if err == unix.EFAULT {
		// vmsplice pins the user pages. The NOMMU wasm32 kernel has no VMA
		// for wasm linear memory, so it cannot, but it must have been given
		// the buffer: an unmarshalled iovec reached it with length zero and
		// transferred nothing.
		t.Log("Vmsplice: the kernel cannot pin wasm memory")
		return
	}
	if err != nil || n != len(data) {
		t.Fatalf("Vmsplice = %d, %v", n, err)
	}
	buf := make([]byte, 16)
	if n, err := unix.Read(p[0], buf); err != nil || !bytes.Equal(buf[:n], data) {
		t.Errorf("read after Vmsplice = %q, %v", buf[:n], err)
	}
}

func TestWasmABISocketFilter(t *testing.T) {
	a, b := socketpair(t, unix.SOCK_DGRAM)
	// A classic BPF program that drops every packet: ret #0.
	filter := []unix.SockFilter{{Code: unix.BPF_RET | unix.BPF_K, K: 0}}
	prog := unix.SockFprog{Len: uint16(len(filter)), Filter: &filter[0]}
	if err := unix.SetsockoptSockFprog(b, unix.SOL_SOCKET, unix.SO_ATTACH_FILTER, &prog); err != nil {
		t.Fatal(err)
	}
	if _, err := unix.Write(a, []byte("dropped")); err != nil {
		t.Fatal(err)
	}
	if !recvTimesOut(t, b) {
		t.Error("a datagram passed a drop-everything socket filter")
	}
}

func TestWasmABIRlimit(t *testing.T) {
	var rlim unix.Rlimit
	if err := unix.Getrlimit(unix.RLIMIT_NOFILE, &rlim); err != nil || rlim.Cur == 0 || rlim.Cur > rlim.Max {
		t.Errorf("Getrlimit(RLIMIT_NOFILE) = %+v, %v", rlim, err)
	}
}

func TestWasmABILayouts(t *testing.T) {
	// Structures passed to the kernel without conversion must have its layout.
	for _, c := range []struct {
		name      string
		got, want uintptr
	}{
		{"Timespec", unsafe.Sizeof(unix.Timespec{}), 16},
		{"ItimerSpec", unsafe.Sizeof(unix.ItimerSpec{}), 32},
		{"Statfs_t", unsafe.Sizeof(unix.Statfs_t{}), 88},
		{"EpollEvent", unsafe.Sizeof(unix.EpollEvent{}), 16},
		{"Rlimit", unsafe.Sizeof(unix.Rlimit{}), 16},
	} {
		if c.got != c.want {
			t.Errorf("sizeof(%s) = %d; want %d", c.name, c.got, c.want)
		}
	}
}

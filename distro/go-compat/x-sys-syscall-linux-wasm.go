// Copyright 2026 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

//go:build wasm && linux

// linux/wasm has 64-bit Go pointers and integers, but the wasm32 kernel is an
// asm-generic 32-bit Linux. It takes i386-style 32-bit argument slots, so
// zsyscall_linux_wasm.go is generated with mksyscall -l32, and its __NR3264_*
// entries are the 32-bit variants (llseek, statfs64, ftruncate64, mmap2,
// sync_file_range2). Timespec and Timeval follow musl's time64 layout, so
// time-carrying calls use the *_time64 entries, and structures the kernel
// only offers with 32-bit timevals or pointers are converted here.
//
// The shared wrappers this file replaces are renamed to *Unmarshaled in
// zsyscall_linux.go and syscall_linux.go when the package is generated.

package unix

import (
	"runtime"
	"unsafe"
)

//sys	Fadvise(fd int, offset int64, length int64, advice int) (err error) = SYS_FADVISE64
//sys	Fchown(fd int, uid int, gid int) (err error)
//sys	Ftruncate(fd int, length int64) (err error)
//sysnb	Getegid() (egid int)
//sysnb	Geteuid() (euid int)
//sysnb	Getgid() (gid int)
//sysnb	Getuid() (uid int)
//sys	Listen(s int, n int) (err error)
//sys	MemfdSecret(flags int) (fd int, err error)
//sys	pread(fd int, p []byte, offset int64) (n int, err error) = SYS_PREAD64
//sys	pwrite(fd int, p []byte, offset int64) (n int, err error) = SYS_PWRITE64
//sys	Renameat(olddirfd int, oldpath string, newdirfd int, newpath string) (err error)

// The kernel's lseek entry is llseek, which takes the offset as two words and
// stores the result through a pointer.
func Seek(fd int, offset int64, whence int) (newoffset int64, err error) {
	_, _, e := Syscall6(SYS_LSEEK, uintptr(fd), uintptr(offset>>32), uintptr(uint32(offset)), uintptr(unsafe.Pointer(&newoffset)), uintptr(whence), 0)
	if e != 0 {
		return 0, errnoErr(e)
	}
	return newoffset, nil
}

func Select(nfd int, r *FdSet, w *FdSet, e *FdSet, timeout *Timeval) (n int, err error) {
	var ts *Timespec
	if timeout != nil {
		ts = &Timespec{Sec: timeout.Sec, Nsec: int32(timeout.Usec * 1000)}
	}
	return pselect6(nfd, r, w, e, ts, nil)
}

//sys	sendfile(outfd int, infd int, offset *int64, count int) (written int, err error)
//sys	setfsgid(gid int) (prev int, err error)
//sys	setfsuid(uid int) (prev int, err error)
//sys	Shutdown(fd int, how int) (err error)
//sys	Splice(rfd int, roff *int64, wfd int, woff *int64, len int, flags int) (n int64, err error)

// Stat_t has musl's time64 layout. The kernel's fstatat64 fills the
// asm-generic stat64 structure with 32-bit timestamps, so use statx, as musl
// does, and convert.
func Fstatat(dirfd int, path string, stat *Stat_t, flags int) error {
	var r Statx_t
	// Do it the glibc way, add AT_NO_AUTOMOUNT.
	if err := Statx(dirfd, path, AT_NO_AUTOMOUNT|flags, STATX_BASIC_STATS, &r); err != nil {
		return err
	}

	*stat = Stat_t{
		Dev:     Mkdev(r.Dev_major, r.Dev_minor),
		Ino:     r.Ino,
		Mode:    uint32(r.Mode),
		Nlink:   r.Nlink,
		Uid:     r.Uid,
		Gid:     r.Gid,
		Rdev:    Mkdev(r.Rdev_major, r.Rdev_minor),
		Size:    int64(r.Size),
		Blksize: int32(r.Blksize),
		Blocks:  int64(r.Blocks),
		Atim:    timespecFromStatxTimestamp(r.Atime),
		Mtim:    timespecFromStatxTimestamp(r.Mtime),
		Ctim:    timespecFromStatxTimestamp(r.Ctime),
	}
	return nil
}

func timespecFromStatxTimestamp(x StatxTimestamp) Timespec {
	return Timespec{Sec: x.Sec, Nsec: int32(x.Nsec)}
}

func Fstat(fd int, stat *Stat_t) (err error) {
	return Fstatat(fd, "", stat, AT_EMPTY_PATH)
}

func Stat(path string, stat *Stat_t) (err error) {
	return Fstatat(AT_FDCWD, path, stat, 0)
}

func Lchown(path string, uid int, gid int) (err error) {
	return Fchownat(AT_FDCWD, path, uid, gid, AT_SYMLINK_NOFOLLOW)
}

func Lstat(path string, stat *Stat_t) (err error) {
	return Fstatat(AT_FDCWD, path, stat, AT_SYMLINK_NOFOLLOW)
}

// The kernel's statfs entries are statfs64 and fstatfs64, which take the
// structure size. Statfs_t matches the kernel's statfs64.
//sys	fstatfs64(fd int, size uintptr, buf *Statfs_t) (err error) = SYS_FSTATFS
//sys	statfs64(path string, size uintptr, buf *Statfs_t) (err error) = SYS_STATFS

func Fstatfs(fd int, buf *Statfs_t) (err error) {
	return fstatfs64(fd, unsafe.Sizeof(*buf), buf)
}

func Statfs(path string, buf *Statfs_t) (err error) {
	return statfs64(path, unsafe.Sizeof(*buf), buf)
}

// wasm32 has sync_file_range2, which takes the flags before the range.
//sys	syncFileRange2(fd int, flags int, off int64, n int64) (err error) = SYS_SYNC_FILE_RANGE2

func SyncFileRange(fd int, off int64, n int64, flags int) error {
	return syncFileRange2(fd, flags, off, n)
}

//sys	Truncate(path string, length int64) (err error)

func Ustat(dev int, ubuf *Ustat_t) (err error) {
	return ENOSYS
}

//sys	accept4(s int, rsa *RawSockaddrAny, addrlen *_Socklen, flags int) (fd int, err error)
//sys	bind(s int, addr unsafe.Pointer, addrlen _Socklen) (err error)
//sys	connect(s int, addr unsafe.Pointer, addrlen _Socklen) (err error)
//sysnb	getgroups(n int, list *_Gid_t) (nn int, err error)
//sysnb	setgroups(n int, list *_Gid_t) (err error)
//sys	getsockopt(s int, level int, name int, val unsafe.Pointer, vallen *_Socklen) (err error)
//sys	setsockopt(s int, level int, name int, val unsafe.Pointer, vallen uintptr) (err error)
//sysnb	socket(domain int, typ int, proto int) (fd int, err error)
//sysnb	socketpair(domain int, typ int, proto int, fd *[2]int32) (err error)
//sysnb	getpeername(fd int, rsa *RawSockaddrAny, addrlen *_Socklen) (err error)
//sysnb	getsockname(fd int, rsa *RawSockaddrAny, addrlen *_Socklen) (err error)
//sys	recvfrom(fd int, p []byte, flags int, from *RawSockaddrAny, fromlen *_Socklen) (n int, err error)
//sys	sendto(s int, buf []byte, flags int, to unsafe.Pointer, addrlen _Socklen) (err error)

// The kernel's mmap entry is mmap2, which takes the offset in pages.
//sys	mmap2(addr uintptr, length uintptr, prot int, flags int, fd int, pageOffset uintptr) (xaddr uintptr, err error) = SYS_MMAP

func mmap(addr uintptr, length uintptr, prot int, flags int, fd int, offset int64) (xaddr uintptr, err error) {
	page := uintptr(offset / 4096)
	if offset != int64(page)*4096 {
		return 0, EINVAL
	}
	return mmap2(addr, length, prot, flags, fd, page)
}

func Gettimeofday(tv *Timeval) (err error) {
	var ts Timespec
	if err := ClockGettime(CLOCK_REALTIME, &ts); err != nil {
		return err
	}
	*tv = Timeval{Sec: ts.Sec, Usec: int64(ts.Nsec) / 1000}
	return nil
}

func Settimeofday(tv *Timeval) (err error) {
	if tv.Usec < 0 || tv.Usec >= 1e6 {
		return EINVAL
	}
	ts := Timespec{Sec: tv.Sec, Nsec: int32(tv.Usec * 1000)}
	return ClockSettime(CLOCK_REALTIME, &ts)
}

func Nanosleep(time *Timespec, leftover *Timespec) (err error) {
	return ClockNanosleep(CLOCK_REALTIME, 0, time, leftover)
}

func setTimespec(sec, nsec int64) Timespec {
	return Timespec{Sec: sec, Nsec: int32(nsec)}
}

func setTimeval(sec, usec int64) Timeval {
	return Timeval{Sec: sec, Usec: usec}
}

func futimesat(dirfd int, path string, tv *[2]Timeval) (err error) {
	if tv == nil {
		return utimensat(dirfd, path, nil, 0)
	}

	ts := []Timespec{
		NsecToTimespec(TimevalToNsec(tv[0])),
		NsecToTimespec(TimevalToNsec(tv[1])),
	}
	return utimensat(dirfd, path, (*[2]Timespec)(unsafe.Pointer(&ts[0])), 0)
}

func Time(t *Time_t) (Time_t, error) {
	var tv Timeval
	err := Gettimeofday(&tv)
	if err != nil {
		return 0, err
	}
	if t != nil {
		*t = Time_t(tv.Sec)
	}
	return Time_t(tv.Sec), nil
}

func Utime(path string, buf *Utimbuf) error {
	if buf == nil {
		return Utimes(path, nil)
	}
	tv := []Timeval{
		{Sec: buf.Actime},
		{Sec: buf.Modtime},
	}
	return Utimes(path, tv)
}

func utimes(path string, tv *[2]Timeval) (err error) {
	if tv == nil {
		return utimensat(AT_FDCWD, path, nil, 0)
	}

	ts := []Timespec{
		NsecToTimespec(TimevalToNsec(tv[0])),
		NsecToTimespec(TimevalToNsec(tv[1])),
	}
	return utimensat(AT_FDCWD, path, (*[2]Timespec)(unsafe.Pointer(&ts[0])), 0)
}

// Getrlimit uses prlimit64. The kernel's getrlimit fills a struct rlimit of
// 32-bit longs, which does not match Rlimit.
func Getrlimit(resource int, rlim *Rlimit) error {
	return Prlimit(0, resource, nil, rlim)
}

func (iov *Iovec) SetLen(length int) {
	iov.Len = uint32(length)
}

func (msghdr *Msghdr) SetControllen(length int) {
	msghdr.Controllen = uint32(length)
}

func (msghdr *Msghdr) SetIovlen(length int) {
	msghdr.Iovlen = int32(length)
}

func (cmsg *Cmsghdr) SetLen(length int) {
	cmsg.Len = uint32(length)
}

func (rsa *RawSockaddrNFCLLCP) SetServiceNameLen(length int) {
	rsa.Service_name_len = uint32(length)
}

func Pause() error {
	_, err := ppoll(nil, 0, nil, nil)
	return err
}

//sys	kexecFileLoad(kernelFd int, initrdFd int, cmdlineLen int, cmdline string, flags int) (err error)

func KexecFileLoad(kernelFd int, initrdFd int, cmdline string, flags int) error {
	cmdlineLen := len(cmdline)
	if cmdlineLen > 0 {
		// Account for the additional NULL byte added by
		// BytePtrFromString in kexecFileLoad. The kexec_file_load
		// syscall expects a NULL-terminated string.
		cmdlineLen++
	}
	return kexecFileLoad(kernelFd, initrdFd, cmdlineLen, cmdline, flags)
}

const SYS_FSTATAT = SYS_NEWFSTATAT

// fanotifyMark's uint64 mask makes its calling sequence architecture-specific,
// so it is absent from the merged Linux file.
//sys	fanotifyMark(fd int, flags uint, mask uint64, dirFd int, pathname *byte) (err error)
//sys	Fallocate(fd int, mode uint32, off int64, len int64) (err error)
//sys	Tee(rfd int, wfd int, len int, flags int) (n int64, err error)

// kernelTimex is the kernel's struct __kernel_timex, used by clock_adjtime64.
// Timex has musl's layout, with 32-bit longs and a time64 Timeval.
type kernelTimex struct {
	Modes     uint32
	_         int32
	Offset    int64
	Freq      int64
	Maxerror  int64
	Esterror  int64
	Status    int32
	_         int32
	Constant  int64
	Precision int64
	Tolerance int64
	Time      Timeval
	Tick      int64
	Ppsfreq   int64
	Jitter    int64
	Shift     int32
	_         int32
	Stabil    int64
	Jitcnt    int64
	Calcnt    int64
	Errcnt    int64
	Stbcnt    int64
	Tai       int32
	_         [11]int32
}

//sys	clockAdjtime64(clockid int32, buf *kernelTimex) (state int, err error) = SYS_CLOCK_ADJTIME64

func ClockAdjtime(clockid int32, buf *Timex) (state int, err error) {
	k := kernelTimex{
		Modes:     buf.Modes,
		Offset:    int64(buf.Offset),
		Freq:      int64(buf.Freq),
		Maxerror:  int64(buf.Maxerror),
		Esterror:  int64(buf.Esterror),
		Status:    buf.Status,
		Constant:  int64(buf.Constant),
		Precision: int64(buf.Precision),
		Tolerance: int64(buf.Tolerance),
		Time:      buf.Time,
		Tick:      int64(buf.Tick),
		Ppsfreq:   int64(buf.Ppsfreq),
		Jitter:    int64(buf.Jitter),
		Shift:     buf.Shift,
		Stabil:    int64(buf.Stabil),
		Jitcnt:    int64(buf.Jitcnt),
		Calcnt:    int64(buf.Calcnt),
		Errcnt:    int64(buf.Errcnt),
		Stbcnt:    int64(buf.Stbcnt),
		Tai:       buf.Tai,
	}
	state, err = clockAdjtime64(clockid, &k)
	if err != nil {
		return state, err
	}
	*buf = Timex{
		Modes:     k.Modes,
		Offset:    int32(k.Offset),
		Freq:      int32(k.Freq),
		Maxerror:  int32(k.Maxerror),
		Esterror:  int32(k.Esterror),
		Status:    k.Status,
		Constant:  int32(k.Constant),
		Precision: int32(k.Precision),
		Tolerance: int32(k.Tolerance),
		Time:      k.Time,
		Tick:      int32(k.Tick),
		Ppsfreq:   int32(k.Ppsfreq),
		Jitter:    int32(k.Jitter),
		Shift:     k.Shift,
		Stabil:    int32(k.Stabil),
		Jitcnt:    int32(k.Jitcnt),
		Calcnt:    int32(k.Calcnt),
		Errcnt:    int32(k.Errcnt),
		Stbcnt:    int32(k.Stbcnt),
		Tai:       k.Tai,
	}
	return state, nil
}

func Adjtimex(buf *Timex) (state int, err error) {
	return ClockAdjtime(CLOCK_REALTIME, buf)
}

// getrusage, wait4 and waitid have no time64 variants: the kernel fills a
// struct rusage with 32-bit timevals and longs.
type kernelRusage struct {
	Utime  [2]int32
	Stime  [2]int32
	Fields [14]int32
}

func (r *Rusage) fromKernel(k *kernelRusage) {
	*r = Rusage{
		Utime:    Timeval{Sec: int64(k.Utime[0]), Usec: int64(k.Utime[1])},
		Stime:    Timeval{Sec: int64(k.Stime[0]), Usec: int64(k.Stime[1])},
		Maxrss:   k.Fields[0],
		Ixrss:    k.Fields[1],
		Idrss:    k.Fields[2],
		Isrss:    k.Fields[3],
		Minflt:   k.Fields[4],
		Majflt:   k.Fields[5],
		Nswap:    k.Fields[6],
		Inblock:  k.Fields[7],
		Oublock:  k.Fields[8],
		Msgsnd:   k.Fields[9],
		Msgrcv:   k.Fields[10],
		Nsignals: k.Fields[11],
		Nvcsw:    k.Fields[12],
		Nivcsw:   k.Fields[13],
	}
}

//sysnb	getrusageKernel(who int, rusage *kernelRusage) (err error) = SYS_GETRUSAGE
//sys	wait4Kernel(pid int, wstatus *_C_int, options int, rusage *kernelRusage) (wpid int, err error) = SYS_WAIT4
//sys	waitidKernel(idType int, id int, info *Siginfo, options int, rusage *kernelRusage) (err error) = SYS_WAITID

func Getrusage(who int, rusage *Rusage) (err error) {
	var k kernelRusage
	if err := getrusageKernel(who, &k); err != nil {
		return err
	}
	rusage.fromKernel(&k)
	return nil
}

func wait4(pid int, wstatus *_C_int, options int, rusage *Rusage) (wpid int, err error) {
	if rusage == nil {
		return wait4Kernel(pid, wstatus, options, nil)
	}
	var k kernelRusage
	wpid, err = wait4Kernel(pid, wstatus, options, &k)
	if err == nil {
		rusage.fromKernel(&k)
	}
	return wpid, err
}

func Waitid(idType int, id int, info *Siginfo, options int, rusage *Rusage) (err error) {
	if rusage == nil {
		return waitidKernel(idType, id, info, options, nil)
	}
	var k kernelRusage
	err = waitidKernel(idType, id, info, options, &k)
	if err == nil {
		rusage.fromKernel(&k)
	}
	return err
}

// getitimer and setitimer have no time64 variants: the kernel's itimerval
// holds 32-bit timevals.
type kernelItimerval struct {
	Interval [2]int32
	Value    [2]int32
}

func (k *kernelItimerval) set(v *Itimerval) {
	*k = kernelItimerval{
		Interval: [2]int32{int32(v.Interval.Sec), int32(v.Interval.Usec)},
		Value:    [2]int32{int32(v.Value.Sec), int32(v.Value.Usec)},
	}
}

func (k *kernelItimerval) get() Itimerval {
	return Itimerval{
		Interval: Timeval{Sec: int64(k.Interval[0]), Usec: int64(k.Interval[1])},
		Value:    Timeval{Sec: int64(k.Value[0]), Usec: int64(k.Value[1])},
	}
}

//sys	getitimerKernel(which int, currValue *kernelItimerval) (err error) = SYS_GETITIMER
//sys	setitimerKernel(which int, newValue *kernelItimerval, oldValue *kernelItimerval) (err error) = SYS_SETITIMER

func getitimer(which int, currValue *Itimerval) (err error) {
	var k kernelItimerval
	if err := getitimerKernel(which, &k); err != nil {
		return err
	}
	*currValue = k.get()
	return nil
}

func setitimer(which int, newValue *Itimerval, oldValue *Itimerval) (err error) {
	for _, tv := range [...]Timeval{newValue.Interval, newValue.Value} {
		if tv.Sec != int64(int32(tv.Sec)) || tv.Usec < 0 || tv.Usec >= 1e6 {
			return EINVAL
		}
	}
	var knew, kold kernelItimerval
	knew.set(newValue)
	if err := setitimerKernel(which, &knew, &kold); err != nil {
		return err
	}
	if oldValue != nil {
		*oldValue = kold.get()
	}
	return nil
}

// Go pointers are 64 bits, while the kernel's pointer-carrying structures are
// ILP32. Marshal them to the kernel layout at the syscall boundary.

// ppoll's fifth argument is the size of the signal mask, which the shared
// wrapper omits. The kernel's sigset_t is 64 bits.
func ppoll(fds *PollFd, nfds int, timeout *Timespec, sigmask *Sigset_t) (n int, err error) {
	var size uintptr
	if sigmask != nil {
		size = _C__NSIG / 8
	}
	r0, _, e1 := Syscall6(SYS_PPOLL_TIME64, uintptr(unsafe.Pointer(fds)), uintptr(nfds), uintptr(unsafe.Pointer(timeout)), uintptr(unsafe.Pointer(sigmask)), size, 0)
	if e1 != 0 {
		return 0, errnoErr(e1)
	}
	return int(r0), nil
}

// pselect6's last argument points to a pair of a sigset pointer and its size.
type wasmSigsetArgpack struct {
	ss    uint32
	ssLen uint32
}

func pselect6(nfd int, r *FdSet, w *FdSet, e *FdSet, timeout *Timespec, sigmask *sigset_argpack) (n int, err error) {
	var wire *wasmSigsetArgpack
	if sigmask != nil {
		wire = &wasmSigsetArgpack{
			ss:    uint32(uintptr(unsafe.Pointer(sigmask.ss))),
			ssLen: uint32(sigmask.ssLen),
		}
	}
	r0, _, e1 := Syscall6(SYS_PSELECT6_TIME64, uintptr(nfd), uintptr(unsafe.Pointer(r)), uintptr(unsafe.Pointer(w)), uintptr(unsafe.Pointer(e)), uintptr(unsafe.Pointer(timeout)), uintptr(unsafe.Pointer(wire)))
	runtime.KeepAlive(sigmask)
	if e1 != 0 {
		return 0, errnoErr(e1)
	}
	return int(r0), nil
}

func SetsockoptSockFprog(fd, level, opt int, fprog *SockFprog) error {
	wire := struct {
		Len    uint16
		_      uint16
		Filter uint32
	}{
		Len:    fprog.Len,
		Filter: uint32(uintptr(unsafe.Pointer(fprog.Filter))),
	}
	// Call the kernel directly: a Go call between taking the filter's
	// address and the syscall could grow the stack and move the filter.
	_, _, e1 := Syscall6(SYS_SETSOCKOPT, uintptr(fd), uintptr(level), uintptr(opt), uintptr(unsafe.Pointer(&wire)), unsafe.Sizeof(wire), 0)
	runtime.KeepAlive(fprog)
	if e1 != 0 {
		return errnoErr(e1)
	}
	return nil
}

type wasmMsghdr struct {
	Name       uint32
	Namelen    uint32
	Iov        uint32
	Iovlen     int32
	Control    uint32
	Controllen uint32
	Flags      int32
}

func wasmMsghdrFor(msg *Msghdr) (wasmMsghdr, []wasmIovec, error) {
	if msg.Iovlen < 0 {
		return wasmMsghdr{}, nil, EINVAL
	}
	var iovecs []wasmIovec
	if msg.Iovlen != 0 {
		if msg.Iov == nil {
			return wasmMsghdr{}, nil, EFAULT
		}
		iovecs = wasmIovecs(nil, unsafe.Slice(msg.Iov, int(msg.Iovlen)))
	}
	return wasmMsghdr{
		Name:       uint32(uintptr(unsafe.Pointer(msg.Name))),
		Namelen:    msg.Namelen,
		Iov:        uint32(uintptr(wasmIovecPointer(iovecs))),
		Iovlen:     msg.Iovlen,
		Control:    uint32(uintptr(unsafe.Pointer(msg.Control))),
		Controllen: msg.Controllen,
		Flags:      msg.Flags,
	}, iovecs, nil
}

func recvmsg(s int, msg *Msghdr, flags int) (n int, err error) {
	wire, iovecs, err := wasmMsghdrFor(msg)
	if err != nil {
		return 0, err
	}
	r0, _, e1 := Syscall(SYS_RECVMSG, uintptr(s), uintptr(unsafe.Pointer(&wire)), uintptr(flags))
	runtime.KeepAlive(iovecs)
	runtime.KeepAlive(msg)
	if e1 != 0 {
		return 0, errnoErr(e1)
	}
	msg.Namelen = wire.Namelen
	msg.Controllen = wire.Controllen
	msg.Flags = wire.Flags
	return int(r0), nil
}

func sendmsg(s int, msg *Msghdr, flags int) (n int, err error) {
	wire, iovecs, err := wasmMsghdrFor(msg)
	if err != nil {
		return 0, err
	}
	r0, _, e1 := Syscall(SYS_SENDMSG, uintptr(s), uintptr(unsafe.Pointer(&wire)), uintptr(flags))
	runtime.KeepAlive(iovecs)
	runtime.KeepAlive(msg)
	if e1 != 0 {
		return 0, errnoErr(e1)
	}
	return int(r0), nil
}

func Vmsplice(fd int, iovs []Iovec, flags int) (int, error) {
	wire := wasmIovecs(nil, iovs)
	n, _, e1 := Syscall6(SYS_VMSPLICE, uintptr(fd), uintptr(wasmIovecPointer(wire)), uintptr(len(wire)), uintptr(flags), 0, 0)
	runtime.KeepAlive(iovs)
	if e1 != 0 {
		return 0, errnoErr(e1)
	}
	return int(n), nil
}

func keyctlIOV(cmd int, arg2 int, payload []Iovec, arg5 int) (err error) {
	wire := wasmIovecs(nil, payload)
	_, _, e1 := Syscall6(SYS_KEYCTL, uintptr(cmd), uintptr(arg2), uintptr(wasmIovecPointer(wire)), uintptr(len(wire)), uintptr(arg5), 0)
	runtime.KeepAlive(payload)
	if e1 != 0 {
		return errnoErr(e1)
	}
	return nil
}

func wasmRemoteIovecs(iovecs []RemoteIovec) []wasmIovec {
	wire := make([]wasmIovec, len(iovecs))
	for i := range iovecs {
		wire[i] = wasmIovec{base: uint32(iovecs[i].Base), len: uint32(iovecs[i].Len)}
	}
	return wire
}

// Convert the remote vectors first: their addresses are not Go pointers, and
// allocating them after taking local addresses could grow the stack.
func ProcessVMReadv(pid int, localIov []Iovec, remoteIov []RemoteIovec, flags uint) (n int, err error) {
	remote := wasmRemoteIovecs(remoteIov)
	local := wasmIovecs(nil, localIov)
	r0, _, e1 := Syscall6(SYS_PROCESS_VM_READV, uintptr(pid), uintptr(wasmIovecPointer(local)), uintptr(len(local)), uintptr(wasmIovecPointer(remote)), uintptr(len(remote)), uintptr(flags))
	runtime.KeepAlive(localIov)
	if e1 != 0 {
		return 0, errnoErr(e1)
	}
	return int(r0), nil
}

func ProcessVMWritev(pid int, localIov []Iovec, remoteIov []RemoteIovec, flags uint) (n int, err error) {
	remote := wasmRemoteIovecs(remoteIov)
	local := wasmIovecs(nil, localIov)
	r0, _, e1 := Syscall6(SYS_PROCESS_VM_WRITEV, uintptr(pid), uintptr(wasmIovecPointer(local)), uintptr(len(local)), uintptr(wasmIovecPointer(remote)), uintptr(len(remote)), uintptr(flags))
	runtime.KeepAlive(localIov)
	if e1 != 0 {
		return 0, errnoErr(e1)
	}
	return int(r0), nil
}

// Copyright 2026 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

//go:build linux && wasm && gc

package unix

import (
	"syscall"
	_ "unsafe" // for go:linkname
)

// wasm has no assembly jump into the syscall package. Bind the raw calls to
// the standard library's implementations directly instead of forwarding
// through Go functions: as bodyless declarations, calls to them keep their
// unsafe.Pointer-derived arguments alive, and no intervening frame can grow
// the stack after an address has been converted to a uintptr.

//go:linkname Syscall syscall.Syscall
func Syscall(trap, a1, a2, a3 uintptr) (r1, r2 uintptr, err syscall.Errno)

//go:linkname Syscall6 syscall.Syscall6
func Syscall6(trap, a1, a2, a3, a4, a5, a6 uintptr) (r1, r2 uintptr, err syscall.Errno)

//go:linkname RawSyscall syscall.RawSyscall
func RawSyscall(trap, a1, a2, a3 uintptr) (r1, r2 uintptr, err syscall.Errno)

//go:linkname RawSyscall6 syscall.RawSyscall6
func RawSyscall6(trap, a1, a2, a3, a4, a5, a6 uintptr) (r1, r2 uintptr, err syscall.Errno)

//go:nosplit
func SyscallNoError(trap, a1, a2, a3 uintptr) (r1, r2 uintptr) {
	r1, r2, _ = Syscall(trap, a1, a2, a3)
	return
}

//go:nosplit
func RawSyscallNoError(trap, a1, a2, a3 uintptr) (r1, r2 uintptr) {
	r1, r2, _ = RawSyscall(trap, a1, a2, a3)
	return
}

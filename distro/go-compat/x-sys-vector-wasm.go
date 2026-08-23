// Copyright 2026 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

//go:build linux && wasm

package unix

import (
	"runtime"
	"unsafe"
)

// Go wasm pointers are 64 bits, while the wasm-linux kernel ABI is ILP32.
// Iovec remains source-compatible with other Go ports, so marshal it to the
// kernel wire layout at the syscall boundary.
type wasmIovec struct {
	base uint32
	len  uint32
}

func wasmIovecs(stack *[minIovec]wasmIovec, iovecs []Iovec) []wasmIovec {
	var wire []wasmIovec
	if len(iovecs) <= len(stack) {
		wire = stack[:len(iovecs)]
	} else {
		wire = make([]wasmIovec, len(iovecs))
	}
	for i := range iovecs {
		wire[i].base = uint32(uintptr(unsafe.Pointer(iovecs[i].Base)))
		wire[i].len = iovecs[i].Len
	}
	return wire
}

func wasmIovecPointer(iovecs []wasmIovec) unsafe.Pointer {
	if len(iovecs) == 0 {
		return unsafe.Pointer(&_zero)
	}
	return unsafe.Pointer(&iovecs[0])
}

func readv(fd int, iovecs []Iovec) (n int, err error) {
	var stack [minIovec]wasmIovec
	wire := wasmIovecs(&stack, iovecs)
	r0, _, e1 := Syscall(SYS_READV, uintptr(fd), uintptr(wasmIovecPointer(wire)), uintptr(len(wire)))
	runtime.KeepAlive(iovecs)
	if e1 != 0 {
		err = errnoErr(e1)
	}
	return int(r0), err
}

func writev(fd int, iovecs []Iovec) (n int, err error) {
	var stack [minIovec]wasmIovec
	wire := wasmIovecs(&stack, iovecs)
	r0, _, e1 := Syscall(SYS_WRITEV, uintptr(fd), uintptr(wasmIovecPointer(wire)), uintptr(len(wire)))
	runtime.KeepAlive(iovecs)
	if e1 != 0 {
		err = errnoErr(e1)
	}
	return int(r0), err
}

func preadvSyscall(fd int, iovecs []Iovec, offsLo, offsHi uintptr) (n int, err error) {
	var stack [minIovec]wasmIovec
	wire := wasmIovecs(&stack, iovecs)
	r0, _, e1 := Syscall6(SYS_PREADV, uintptr(fd), uintptr(wasmIovecPointer(wire)), uintptr(len(wire)), offsLo, offsHi, 0)
	runtime.KeepAlive(iovecs)
	if e1 != 0 {
		err = errnoErr(e1)
	}
	return int(r0), err
}

func pwritevSyscall(fd int, iovecs []Iovec, offsLo, offsHi uintptr) (n int, err error) {
	var stack [minIovec]wasmIovec
	wire := wasmIovecs(&stack, iovecs)
	r0, _, e1 := Syscall6(SYS_PWRITEV, uintptr(fd), uintptr(wasmIovecPointer(wire)), uintptr(len(wire)), offsLo, offsHi, 0)
	runtime.KeepAlive(iovecs)
	if e1 != 0 {
		err = errnoErr(e1)
	}
	return int(r0), err
}

func preadv2Syscall(fd int, iovecs []Iovec, offsLo, offsHi uintptr, flags int) (n int, err error) {
	var stack [minIovec]wasmIovec
	wire := wasmIovecs(&stack, iovecs)
	r0, _, e1 := Syscall6(SYS_PREADV2, uintptr(fd), uintptr(wasmIovecPointer(wire)), uintptr(len(wire)), offsLo, offsHi, uintptr(flags))
	runtime.KeepAlive(iovecs)
	if e1 != 0 {
		err = errnoErr(e1)
	}
	return int(r0), err
}

func pwritev2Syscall(fd int, iovecs []Iovec, offsLo, offsHi uintptr, flags int) (n int, err error) {
	var stack [minIovec]wasmIovec
	wire := wasmIovecs(&stack, iovecs)
	r0, _, e1 := Syscall6(SYS_PWRITEV2, uintptr(fd), uintptr(wasmIovecPointer(wire)), uintptr(len(wire)), offsLo, offsHi, uintptr(flags))
	runtime.KeepAlive(iovecs)
	if e1 != 0 {
		err = errnoErr(e1)
	}
	return int(r0), err
}

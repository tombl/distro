//go:build wasm

package common

const (
	// MaxMapSize is the largest addressable mapping. The kernel currently
	// rejects mmap, but this remains the correct fail-closed ILP32 bound.
	MaxMapSize = 0x7fffffff

	// MaxAllocSize is the maximum synthetic array size used by unsafe slice
	// conversions. Go pointers are 64-bit on this port even though the kernel
	// ABI is ILP32.
	MaxAllocSize = 0x7fffffff
)

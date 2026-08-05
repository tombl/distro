// Code generated from the wasm-linux ILP32 socket ABI; DO NOT EDIT.

package socket

type iovec struct {
	Base *byte
	Len  uint32
}

type msghdr struct {
	Name       *byte
	Namelen    uint32
	Iov        *iovec
	Iovlen     uint32
	Control    *byte
	Controllen uint32
	Flags      int32
}

type mmsghdr struct {
	Hdr msghdr
	Len uint32
}

type cmsghdr struct {
	Len   uint32
	Level int32
	Type  int32
}

const (
	sizeofIovec  = 0x8
	sizeofMsghdr = 0x1c
)

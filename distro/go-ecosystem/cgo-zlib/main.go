// A static cgo program that links a distro C library from buildInputs through
// `#cgo LDFLAGS`, so the prelink must keep the dependency's search path.
package main

/*
#cgo LDFLAGS: -lz
#include <zlib.h>
*/
import "C"

import (
	"bytes"
	"fmt"
	"os"
	"unsafe"
)

func main() {
	input := bytes.Repeat([]byte("static cgo zlib "), 64)
	compressed := make([]byte, C.compressBound(C.uLong(len(input))))
	compressedLen := C.uLongf(len(compressed))
	if rc := C.compress((*C.Bytef)(unsafe.Pointer(&compressed[0])), &compressedLen, (*C.Bytef)(unsafe.Pointer(&input[0])), C.uLong(len(input))); rc != C.Z_OK {
		fmt.Println("compress failed:", rc)
		os.Exit(1)
	}
	output := make([]byte, len(input))
	outputLen := C.uLongf(len(output))
	if rc := C.uncompress((*C.Bytef)(unsafe.Pointer(&output[0])), &outputLen, (*C.Bytef)(unsafe.Pointer(&compressed[0])), compressedLen); rc != C.Z_OK || !bytes.Equal(output[:outputLen], input) {
		fmt.Println("uncompress failed:", rc)
		os.Exit(1)
	}
	fmt.Printf("zlib %s roundtrip: %d -> %d bytes\n", C.GoString(C.zlibVersion()), len(input), compressedLen)
}

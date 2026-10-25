;; Compiles, but its data segment lies past the memory's initial size, so
;; instantiating it fails.
(module
  (import "env" "memory" (memory 1 2 shared))
  (data (i32.const 0x20000) "past the end")
  (func (export "_start")))

;; Its start function copies siginfo, which fails, then traps, so exec fails
;; after the image's memory was allocated.
(module
  (import "env" "memory" (memory 1 2 shared))
  (import "linux" "copy_siginfo" (func $copy_siginfo (param i32) (result i32)))
  (func $start
    (drop (call $copy_siginfo (i32.const 0)))
    unreachable)
  (start $start)
  (func (export "_start") unreachable))

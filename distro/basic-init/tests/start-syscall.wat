;; Its start function runs while the exec that loads it can still fail, so a
;; syscall or siginfo copy from it must fail with ENOSYS rather than act for
;; the old image.
(module
  (import "env" "memory" (memory 1 2 shared))
  (import "linux" "syscall"
    (func $syscall (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
  (import "linux" "copy_siginfo" (func $copy_siginfo (param i32) (result i32)))
  (global $start_ok (mut i32) (i32.const 0))
  (func $start
    ;; getpid, and a siginfo copy over the start of the old image's memory
    (if (i32.and
          (i32.eq (call $syscall (i32.const 172) (i32.const 0) (i32.const 0)
                    (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
                  (i32.const -38))
          (i32.eq (call $copy_siginfo (i32.const 0)) (i32.const -38)))
      (then (global.set $start_ok (i32.const 1)))))
  (start $start)
  (func (export "_start")
    ;; exit_group(start_ok ? 5 : 6)
    (drop (call $syscall (i32.const 94)
            (select (i32.const 5) (i32.const 6) (global.get $start_ok))
            (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
    unreachable))

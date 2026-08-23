const std = @import("../../std.zig");
const SYS = std.os.linux.SYS;

// This is the kernel ABI shared with musl's arch/wasm32/syscall_arch.h. Linux
// syscalls have at most six arguments; unused slots are zero-filled here.
extern "linux" fn syscall(
    number: u32,
    arg1: u32,
    arg2: u32,
    arg3: u32,
    arg4: u32,
    arg5: u32,
    arg6: u32,
) i32;

inline fn raw(number: SYS, args: [6]u32) u32 {
    return @bitCast(syscall(
        @intFromEnum(number),
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        args[5],
    ));
}

pub fn syscall0(number: SYS) u32 {
    return raw(number, .{ 0, 0, 0, 0, 0, 0 });
}

pub fn syscall1(number: SYS, arg1: u32) u32 {
    return raw(number, .{ arg1, 0, 0, 0, 0, 0 });
}

pub fn syscall2(number: SYS, arg1: u32, arg2: u32) u32 {
    return raw(number, .{ arg1, arg2, 0, 0, 0, 0 });
}

pub fn syscall3(number: SYS, arg1: u32, arg2: u32, arg3: u32) u32 {
    return raw(number, .{ arg1, arg2, arg3, 0, 0, 0 });
}

pub fn syscall4(number: SYS, arg1: u32, arg2: u32, arg3: u32, arg4: u32) u32 {
    return raw(number, .{ arg1, arg2, arg3, arg4, 0, 0 });
}

pub fn syscall5(number: SYS, arg1: u32, arg2: u32, arg3: u32, arg4: u32, arg5: u32) u32 {
    return raw(number, .{ arg1, arg2, arg3, arg4, arg5, 0 });
}

pub fn syscall6(number: SYS, arg1: u32, arg2: u32, arg3: u32, arg4: u32, arg5: u32, arg6: u32) u32 {
    return raw(number, .{ arg1, arg2, arg3, arg4, arg5, arg6 });
}

pub const time_t = i64;

// WebAssembly Linux has no vDSO. Calls use libc or the syscall import above.
pub const VDSO = struct {
    pub const CGT_SYM = "";
    pub const CGT_VER = "";
};

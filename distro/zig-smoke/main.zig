const std = @import("std");

extern fn zig_c_smoke() c_int;

pub fn main(init: std.process.Init) !void {
    std.debug.print("hello from zig std on wasm linux\n", .{});

    if (zig_c_smoke() != 23) return error.CInteropFailed;

    const args = try init.minimal.args.toSlice(init.arena.allocator());
    if (args.len != 3 or
        !std.mem.eql(u8, args[1], "alpha") or
        !std.mem.eql(u8, args[2], "beta"))
    {
        return error.InvalidArguments;
    }
    const environment_value = init.environ_map.get("ZIG_SMOKE") orelse
        return error.MissingEnvironment;
    if (!std.mem.eql(u8, environment_value, "works")) {
        return error.InvalidEnvironment;
    }

    var thread_value: usize = 0;
    const thread = try std.Thread.spawn(.{}, struct {
        fn run(value: *usize) void {
            value.* = 42;
        }
    }.run, .{&thread_value});
    thread.join();
    if (thread_value != 42) return error.ThreadFailed;

    const child = try std.process.run(init.gpa, init.io, .{
        .argv = &.{ "/bin/busybox", "echo", "hello from zig clone child" },
    });
    defer init.gpa.free(child.stdout);
    defer init.gpa.free(child.stderr);
    if (!std.mem.eql(u8, child.stdout, "hello from zig clone child\n") or
        child.stderr.len != 0)
    {
        return error.ChildOutputMismatch;
    }
    switch (child.term) {
        .exited => |status| if (status != 0) return error.ChildFailed,
        else => return error.ChildFailed,
    }
}

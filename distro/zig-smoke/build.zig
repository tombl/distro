const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const executable = b.addExecutable(.{
        .name = "zig-smoke",
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    executable.root_module.addCSourceFile(.{
        .file = b.path("c-smoke.c"),
        .flags = &.{},
    });
    b.installArtifact(executable);
}

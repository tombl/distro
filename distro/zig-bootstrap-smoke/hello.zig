// Deliberately avoid Zig's standard library and libc discovery here. This is
// the bootstrap canary: an unmodified upstream compiler emits the application
// object while the distro supplies crt1.o and libc.a explicitly.
extern fn puts(message: [*:0]const u8) c_int;

// musl owns the executable entry point. Declaring it prevents Zig's startup
// module from synthesizing another _start for this Linux executable.
pub extern fn _start() noreturn;

export fn __main_argc_argv(argc: c_int, argv: [*]const [*:0]const u8) c_int {
    _ = argc;
    _ = argv;
    _ = puts("hello from unpatched zig on wasm linux");
    return 0;
}

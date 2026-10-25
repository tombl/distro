// linux-raw-sys normally obtains ioctl numbers by executing a helper for each
// architecture. WebAssembly binaries cannot run on the build host, so keep the
// target's binding deliberately narrow. These opcodes use asm-generic's ioctl
// encoding and only scalar operand sizes; their values follow directly from
// the authoritative kernel headers and wasm32's four-byte int and long.

pub const TIOCGPTPEER: u32 = 0x0000_5441; // _IO('T', 0x41)
pub const FIFREEZE: u32 = 0xc004_5877; // _IOWR('X', 119, int)
pub const FS_IOC_GETVERSION: u32 = 0x8004_7601; // _IOR('v', 1, long)
pub const FS_IOC_SETVERSION: u32 = 0x4004_7602; // _IOW('v', 2, long)
pub const TUNGETDEVNETNS: u32 = 0x0000_54e3; // _IO('T', 227)
pub const TUNSETNOCSUM: u32 = 0x4004_54c8; // _IOW('T', 200, int)
pub const USBDEVFS_CLAIMINTERFACE: u32 = 0x8004_550f; // _IOR('U', 15, uint)
pub const EXT4_IOC_RESIZE_FS: u32 = 0x4008_6610; // _IOW('f', 16, u64)

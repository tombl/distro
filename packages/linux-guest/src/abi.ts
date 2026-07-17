// Guest ABI schema (protocol v2).
//
// Every fact here is a KERNEL ABI fact for the wasm32 guest. Injected
// syscalls bypass libc entirely, so these are asm-generic values on a
// 32-bit ILP32 architecture (`__BITS_PER_LONG == 32`), NOT musl values.
// Derived from the vendored kernel sources under `checkouts/linux`; each
// group cites the header it mirrors. Every entry also carries the C
// expression it mirrors so `packages/guest-agent/gen-abi-check.ts` can emit
// one `_Static_assert` per fact and the guest toolchain verifies the schema
// at build time. There is exactly one copy of every number: the ergonomic
// exports (`NR`, `O`, `AT`, ...) are derived from the same check tables.

import { Struct, type Type, U8, U16LE, U32LE, U64LE, I64LE } from "@tombl/linux/bytes";
import { ProtocolError } from "./errors.ts";

// A signed 32-bit little-endian scalar (kernel `int`); bytes.ts lacks one.
const I32LE: Type<number> = {
  get(dv, offset) {
    return dv.getInt32(offset, true);
  },
  set(dv, offset, value) {
    dv.setInt32(offset, value, true);
  },
  size: 4,
};

// ---------------------------------------------------------------------------
// Check tables. gen-abi-check.ts walks these.
// ---------------------------------------------------------------------------

/** A scalar constant that mirrors the C integer expression `c`. */
export interface ScalarCheck {
  c: string;
  value: number;
}

/** One field of a struct: mirrors `offsetof(type, c)` and (when `size` is
 *  non-null) `sizeof(((type*)0)->c)`. */
export interface FieldCheck {
  c: string;
  offset: number;
  size: number | null;
}

/** A struct layout that mirrors the C `type`. `sizeof` is asserted only when
 *  non-null (musl structs with trailing flexible/fixed arrays skip it). */
export interface StructCheck {
  c: string;
  sizeof: number | null;
  fields: FieldCheck[];
}

/** A boolean C expression that must evaluate true at compile time. Used for
 *  the wait-status macros, which are asserted by evaluating on sample inputs. */
export interface ExprCheck {
  name: string;
  expr: string;
}

function scalarGroup<T extends Record<string, number>>(prefix: string, entries: T) {
  const checks: ScalarCheck[] = Object.entries(entries).map(([key, value]) => ({
    c: prefix + key,
    value,
  }));
  return { values: entries, checks };
}

function defineStruct<T extends object>(
  cType: string,
  layout: { [K in keyof T]: Type<T[K]> },
  options: { assertSizeof?: boolean } = {},
) {
  const fields: FieldCheck[] = [];
  let offset = 0;
  for (const key of Object.keys(layout) as (keyof T & string)[]) {
    const type = layout[key];
    fields.push({ c: key, offset, size: type.size });
    offset += type.size;
  }
  const Schema = Struct(layout);
  const check: StructCheck = {
    c: cType,
    sizeof: options.assertSizeof ? offset : null,
    fields,
  };
  return { Schema, check, size: offset };
}

// ---------------------------------------------------------------------------
// Syscall numbers.
// checkouts/linux/include/uapi/asm-generic/unistd.h
// wasm includes it verbatim (arch/wasm/include/uapi/asm/unistd.h). On this
// 32-bit arch the __NR3264_* aliases resolve to the 64-suffixed variants:
// __NR_llseek=62, __NR_fstatat64=79, __NR_ftruncate64=46. renameat (38) is
// present because arch/wasm defines __ARCH_WANT_RENAMEAT.
// ---------------------------------------------------------------------------

const nr = scalarGroup("__NR_", {
  openat: 56,
  close: 57,
  read: 63,
  write: 64,
  llseek: 62, // __NR3264_lseek -> sys_llseek on ILP32
  fstatat64: 79, // __NR3264_fstatat -> sys_fstatat64 on ILP32
  ftruncate64: 46, // __NR3264_ftruncate -> sys_ftruncate64 on ILP32
  fsync: 82,
  getdents64: 61,
  mkdirat: 34,
  unlinkat: 35,
  renameat: 38,
  symlinkat: 36,
  readlinkat: 78,
  fchmodat: 53,
  fchownat: 54,
  kill: 129,
  getpid: 172,
});

/** asm-generic syscall numbers, e.g. `NR.openat === 56`. */
export const NR = nr.values;

// ---------------------------------------------------------------------------
// Open flags and *at() flags.
// O_* : checkouts/linux/include/uapi/asm-generic/fcntl.h (octal literals).
// AT_*: checkouts/linux/include/uapi/linux/fcntl.h.
// ---------------------------------------------------------------------------

const o = scalarGroup("O_", {
  RDONLY: 0o0, // 0
  WRONLY: 0o1, // 1
  RDWR: 0o2, // 2
  CREAT: 0o100, // 64
  EXCL: 0o200, // 128
  TRUNC: 0o1000, // 512
  APPEND: 0o2000, // 1024
  NONBLOCK: 0o4000, // 2048
  DIRECTORY: 0o200000, // 65536
  CLOEXEC: 0o2000000, // 1048576
  PATH: 0o10000000, // 2097152
});

/** Open flags, e.g. `O.CLOEXEC`. */
export const O = o.values;

const at = scalarGroup("AT_", {
  FDCWD: -100,
  SYMLINK_NOFOLLOW: 0x100, // 256
  REMOVEDIR: 0x200, // 512
});

/** *at() flags, e.g. `AT.FDCWD === -100`. */
export const AT = at.values;

// ---------------------------------------------------------------------------
// File-mode type bits (for st_mode decoding).
// checkouts/linux/include/uapi/linux/stat.h (octal literals).
// ---------------------------------------------------------------------------

const sIf = scalarGroup("S_IF", {
  MT: 0o170000, // 61440 mask
  REG: 0o100000, // 32768
  DIR: 0o040000, // 16384
  LNK: 0o120000, // 40960
});

/** File-type bits: `(mode & S_IF.MT) === S_IF.DIR`, etc. */
export const S_IF = sIf.values;

// ---------------------------------------------------------------------------
// Directory-entry type bytes (linux_dirent64.d_type / struct dirent.d_type).
// checkouts/musl/include/dirent.h (matches kernel DT_* in linux/fs.h).
// ---------------------------------------------------------------------------

const dt = scalarGroup("DT_", {
  REG: 8,
  DIR: 4,
  LNK: 10,
});

/** Directory-entry type bytes, e.g. `DT.DIR === 4`. */
export const DT = dt.values;

// ---------------------------------------------------------------------------
// struct stat64 — the layout fstatat64 (__NR_fstatat64 = 79) fills on this
// ILP32 arch. Confirmed via checkouts/linux/fs/stat.c: SYSCALL_DEFINE4(
// fstatat64, ...) -> cp_new_stat64() -> struct stat64. Layout from
// arch/wasm/include/generated/uapi/asm/stat.h -> asm-generic/stat.h (the
// __BITS_PER_LONG != 64 || __ARCH_WANT_STAT64 branch). No padding beyond the
// explicit __pad/__unused members: every 8-byte member is naturally aligned,
// total sizeof is 104. Field order is authoritative for offsets.
// ---------------------------------------------------------------------------

const stat = defineStruct<{
  st_dev: bigint;
  st_ino: bigint;
  st_mode: number;
  st_nlink: number;
  st_uid: number;
  st_gid: number;
  st_rdev: bigint;
  __pad1: bigint;
  st_size: bigint;
  st_blksize: number;
  __pad2: number;
  st_blocks: bigint;
  st_atime: number;
  st_atime_nsec: number;
  st_mtime: number;
  st_mtime_nsec: number;
  st_ctime: number;
  st_ctime_nsec: number;
  __unused4: number;
  __unused5: number;
}>(
  "struct stat64",
  {
    st_dev: U64LE, // unsigned long long
    st_ino: U64LE, // unsigned long long
    st_mode: U32LE, // unsigned int
    st_nlink: U32LE, // unsigned int
    st_uid: U32LE, // unsigned int
    st_gid: U32LE, // unsigned int
    st_rdev: U64LE, // unsigned long long
    __pad1: U64LE, // unsigned long long
    st_size: I64LE, // long long
    st_blksize: I32LE, // int
    __pad2: I32LE, // int
    st_blocks: I64LE, // long long
    st_atime: I32LE, // int (seconds)
    st_atime_nsec: U32LE, // unsigned int
    st_mtime: I32LE, // int (seconds)
    st_mtime_nsec: U32LE, // unsigned int
    st_ctime: I32LE, // int (seconds)
    st_ctime_nsec: U32LE, // unsigned int
    __unused4: U32LE, // unsigned int
    __unused5: U32LE, // unsigned int
  },
  { assertSizeof: true },
);

/** Byte layout of `struct stat64` as written by fstatat64. */
export const Stat = stat.Schema;
/** `sizeof(struct stat64)` on wasm32. */
export const statSize = stat.size;

// ---------------------------------------------------------------------------
// struct linux_dirent64 — the record getdents64 (__NR_getdents64 = 61) writes.
// checkouts/linux/include/linux/dirent.h:
//   u64 d_ino; s64 d_off; unsigned short d_reclen; unsigned char d_type;
//   char d_name[] (NUL-terminated).
// linux_dirent64 is not in an installed uapi header, but musl's `struct
// dirent` (checkouts/musl/include/dirent.h) has a byte-identical header
// (ino_t/off_t are 8 bytes on wasm32-musl), so the C check asserts against
// `struct dirent`. Only the header offsets are asserted; total sizeof is
// skipped because musl fixes d_name[256] while the kernel record is flexible.
// ---------------------------------------------------------------------------

const dirent = defineStruct<{
  d_ino: bigint;
  d_off: bigint;
  d_reclen: number;
  d_type: number;
}>("struct dirent", {
  d_ino: U64LE, // u64
  d_off: I64LE, // s64
  d_reclen: U16LE, // unsigned short
  d_type: U8, // unsigned char
});

/** Header of a `linux_dirent64` record (fields before the flexible d_name). */
export const Dirent = dirent.Schema;
/** Byte offset of `d_name` within a `linux_dirent64` record (19). */
export const direntNameOffset = dirent.size;
// d_name follows the fixed header; assert its offset in C too (offset-only).
dirent.check.fields.push({ c: "d_name", offset: direntNameOffset, size: null });

// ---------------------------------------------------------------------------
// Wait-status bit math.
// Semantics from checkouts/musl/include/sys/wait.h:
//   WEXITSTATUS(s) = (s & 0xff00) >> 8
//   WTERMSIG(s)    = s & 0x7f
//   WIFEXITED(s)   = !WTERMSIG(s)
//   WIFSIGNALED(s) = ((s & 0xffff) - 1u) < 0xffu
// ---------------------------------------------------------------------------

export function WIFEXITED(status: number): boolean {
  return (status & 0x7f) === 0;
}
export function WEXITSTATUS(status: number): number {
  return (status & 0xff00) >>> 8;
}
export function WIFSIGNALED(status: number): boolean {
  return ((status & 0xffff) - 1) >>> 0 < 0xff;
}
export function WTERMSIG(status: number): number {
  return status & 0x7f;
}

// Sample-value checks: 0x2a00 = exited with code 42; 0x09 = killed by signal 9.
// gen-abi-check.ts asserts each expression is true at compile time.
const waitChecks: ExprCheck[] = [
  { name: "WIFEXITED(exited)", expr: "WIFEXITED(0x2a00)" },
  { name: "WEXITSTATUS(exited)", expr: "WEXITSTATUS(0x2a00) == 0x2a" },
  { name: "!WIFSIGNALED(exited)", expr: "!WIFSIGNALED(0x2a00)" },
  { name: "WIFSIGNALED(signaled)", expr: "WIFSIGNALED(0x09)" },
  { name: "WTERMSIG(signaled)", expr: "WTERMSIG(0x09) == 9" },
  { name: "!WIFEXITED(signaled)", expr: "!WIFEXITED(0x09)" },
];

// ---------------------------------------------------------------------------
// Directory parsing helper.
// ---------------------------------------------------------------------------

/** Walk a getdents64 buffer, yielding each entry's name and d_type, skipping
 *  "." and "..". Throws {@link ProtocolError} on a malformed record. */
export function parseDirents(buf: Uint8Array): { name: string; dtype: number }[] {
  const entries: { name: string; dtype: number }[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  while (offset + direntNameOffset <= buf.byteLength) {
    const header = new Dirent(buf.subarray(offset));
    const reclen = header.d_reclen;
    if (reclen < direntNameOffset || offset + reclen > buf.byteLength) {
      throw new ProtocolError("malformed getdents64 record");
    }
    const dtype = header.d_type;
    const nameStart = offset + direntNameOffset;
    const limit = offset + reclen;
    let nameEnd = nameStart;
    while (nameEnd < limit && buf[nameEnd] !== 0) nameEnd++;
    const name = decoder.decode(buf.subarray(nameStart, nameEnd));
    if (name !== "." && name !== "..") entries.push({ name, dtype });
    offset += reclen;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Aggregate schema consumed by gen-abi-check.ts.
// ---------------------------------------------------------------------------

/** The complete build-time check schema. gen-abi-check.ts emits one
 *  `_Static_assert` per scalar, per struct field, per struct sizeof, and per
 *  wait expression. */
export const abiChecks: {
  includes: string[];
  scalars: ScalarCheck[];
  structs: StructCheck[];
  exprs: ExprCheck[];
} = {
  includes: [
    "#include <stddef.h>", // offsetof
    "#include <asm/unistd.h>", // __NR_*
    "#include <linux/fcntl.h>", // O_*, AT_*
    "#include <asm/stat.h>", // struct stat64
    "#include <linux/stat.h>", // S_IF*
    "#include <dirent.h>", // struct dirent (== linux_dirent64 header), DT_*
    "#include <sys/wait.h>", // WIF*/W* macros
  ],
  scalars: [...nr.checks, ...o.checks, ...at.checks, ...sIf.checks, ...dt.checks],
  structs: [stat.check, dirent.check],
  exprs: waitChecks,
};

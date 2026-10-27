// SPDX-License-Identifier: MIT

/** Linux errno numbers by name, as `include/uapi/asm-generic/errno*.h` define them. */
const ERRNO = {
  EPERM: 1,
  ENOENT: 2,
  ESRCH: 3,
  EINTR: 4,
  EIO: 5,
  E2BIG: 7,
  EBADF: 9,
  EAGAIN: 11,
  ENOMEM: 12,
  EACCES: 13,
  EBUSY: 16,
  EEXIST: 17,
  EXDEV: 18,
  ENODEV: 19,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  ENOSPC: 28,
  EROFS: 30,
  EPIPE: 32,
  ENAMETOOLONG: 36,
  ENOSYS: 38,
  ENOTEMPTY: 39,
  ELOOP: 40,
  EPROTO: 71,
  EOVERFLOW: 75,
  EOPNOTSUPP: 95,
  ECONNRESET: 104,
  EALREADY: 114,
} as const;

/** The errno codes {@link SystemError} names, such as `"ENOENT"`. */
export type ErrnoCode = keyof typeof ERRNO;

const names = new Map<number, ErrnoCode>(
  Object.entries(ERRNO).map(([name, value]) => [value, name as ErrnoCode]),
);

/**
 * A system call failed with an errno: one the guest's kernel returned, or
 * one a filesystem shared into the guest returns to it.
 *
 * @example Handle a missing file
 * ```ts
 * try {
 *   await guest.fs.readTextFile("/tmp/missing");
 * } catch (error) {
 *   if (error instanceof SystemError && error.code === "ENOENT") {
 *     console.log("no such file");
 *   } else {
 *     throw error;
 *   }
 * }
 * ```
 *
 * @example Fail an operation of a shared filesystem
 * ```ts
 * throw new SystemError("EACCES", "the share is read-only");
 * ```
 */
export class SystemError extends Error {
  /** The errno number, such as 2 for `ENOENT`. */
  readonly errno: number;
  /** The errno's name, or `undefined` for a number this table does not name. */
  readonly code: ErrnoCode | undefined;

  constructor(error: ErrnoCode | number, message?: string) {
    const errno = typeof error === "number" ? error : ERRNO[error];
    if (!Number.isInteger(errno) || errno <= 0) {
      throw new TypeError(`not an errno: ${String(error)}`);
    }
    const code = names.get(errno);
    super(message ?? code ?? `E${errno}`);
    this.name = "SystemError";
    this.errno = errno;
    this.code = code;
  }
}

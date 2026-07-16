const errnoNames: Record<number, string> = {
  1: "EPERM",
  2: "ENOENT",
  3: "ESRCH",
  4: "EINTR",
  5: "EIO",
  9: "EBADF",
  11: "EAGAIN",
  12: "ENOMEM",
  13: "EACCES",
  16: "EBUSY",
  17: "EEXIST",
  18: "EXDEV",
  20: "ENOTDIR",
  21: "EISDIR",
  22: "EINVAL",
  28: "ENOSPC",
  30: "EROFS",
  32: "EPIPE",
  36: "ENAMETOOLONG",
  38: "ENOSYS",
  39: "ENOTEMPTY",
  40: "ELOOP",
  71: "EPROTO",
  75: "EOVERFLOW",
  104: "ECONNRESET",
  114: "EALREADY",
};

export class SystemError extends Error {
  readonly code: string;

  constructor(
    readonly errno: number,
    readonly syscall: string,
    readonly path?: string,
    readonly destination?: string,
  ) {
    const code = errnoNames[errno] ?? `E${errno}`;
    const paths = [path, destination].filter(Boolean).join(" -> ");
    super(`${code}: ${syscall}${paths ? ` '${paths}'` : ""}`);
    this.name = "SystemError";
    this.code = code;
  }
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

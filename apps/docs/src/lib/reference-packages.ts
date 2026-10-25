export const referencePackages = [
  {
    slug: "kernel",
    directory: "kernel",
    name: "@lowland/kernel",
    entrypoints: ["@lowland/kernel", "@lowland/kernel/plugin"],
    description: "APIs for Linux virtual machines and virtio devices.",
    npm: "https://www.npmjs.com/package/@lowland/kernel",
    groups: [
      {
        title: "Boot a machine",
        description: "Configure CPUs and boot assets, start Linux, and control its lifecycle.",
        symbols: ["bootMachine", "BootMachineOptions", "Machine", "MachinePanicError"],
      },
      {
        title: "Attach devices",
        description: "Add block storage, consoles, filesystems, entropy, networks, and sockets.",
        symbols: [
          "Device",
          "blockDevice",
          "BlockStorage",
          "BlockDeviceStorage",
          "consoleDevice",
          "ConsoleDevice",
          "entropyDevice",
          "fileSystemDevice",
          "FS",
          "FSAttributes",
          "FSCreateContext",
          "FSDirectoryEntry",
          "FSDeviceOptions",
          "FSError",
          "FSErrorCode",
          "FSSetAttributes",
          "FSStat",
          "FSTimestamp",
          "ethernetDevice",
          "EthernetDevice",
          "EthernetDeviceOptions",
          "EthernetNetwork",
          "ethernetNetwork",
          "EthernetPort",
          "MacAddress",
          "vsockDevice",
          "VsockConnection",
          "VsockDevice",
        ],
      },
      {
        title: "Run devices in workers",
        description: "Serve a device from a worker so its storage I/O stays off the main thread.",
        symbols: ["Endpoint", "serveDevice", "workerDevice"],
      },
    ],
  },
  {
    slug: "guest",
    directory: "linux-guest",
    name: "@lowland/guest",
    entrypoints: ["@lowland/guest", "@lowland/guest/node", "@lowland/guest/browser"],
    description: "A bootable Linux guest with processes, files, and networking.",
    npm: "https://www.npmjs.com/package/@lowland/guest",
    groups: [
      {
        title: "Start a guest",
        description: "Create the guest plugin and attach its high-level API to a machine.",
        symbols: ["guestAgent", "GuestAgent", "RunResult"],
      },
      {
        title: "Run processes",
        description: "Execute programs, stream their output, inspect exits, and send signals.",
        symbols: ["Exec", "ExecOptions", "ChildProcess", "CommandStatus", "Signal"],
      },
      {
        title: "Work with files",
        description: "Read, write, inspect, and traverse the guest filesystem.",
        symbols: [
          "FileSystem",
          "FileData",
          "FsFile",
          "FileInfo",
          "DirEntry",
          "OpenOptions",
          "WriteFileOptions",
          "MkdirOptions",
          "SeekMode",
        ],
      },
      {
        title: "Mount filesystems",
        description: "Attach and detach filesystems inside the running guest.",
        symbols: ["Mount", "MountOptions", "Unmount", "MountFlags", "UnmountFlags"],
      },
      {
        title: "Connect networks",
        description: "Connect guests to each other, the host, or an HTTP fetch adapter.",
        symbols: [
          "createNetwork",
          "Network",
          "NetworkAddress",
          "NetworkAttachment",
          "NetworkOptions",
          "TcpConnection",
          "TcpConnectOptions",
          "TcpSession",
          "UdpConnection",
          "UdpConnectOptions",
          "hostFetchNetwork",
          "guestFetchHandler",
        ],
      },
      {
        title: "Share host directories",
        description:
          "Expose a host directory to the guest. Import NodeFS from @lowland/guest/node and BrowserFS from @lowland/guest/browser.",
        symbols: ["NodeFS", "NodeFSOptions", "BrowserFS"],
      },
      {
        title: "Handle errors",
        description: "Distinguish guest system errors from protocol failures.",
        symbols: ["SystemError", "ProtocolError"],
      },
    ],
  },
] as const;

export type ReferencePackage = (typeof referencePackages)[number];

export function referenceSymbolId(name: string): string {
  return name.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}

export function referenceGroupId(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(^-|-$)/g, "");
}

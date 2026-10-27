// The reference documents the one published package, lowland, in a section
// per subpath. The facade's section carries the package README.
export const referenceSections = [
  {
    slug: "lowland",
    name: "lowland",
    entrypoints: ["lowland"],
    readme: true,
    description: "A Linux machine with the guest agent and an image, and the lowland command line.",
    groups: [
      {
        title: "Create a machine",
        description: "Boot a machine with an image, disks, shared directories, and a network.",
        symbols: ["Linux", "LinuxOptions", "DiskOptions", "MountOptions"],
      },
    ],
  },
  {
    slug: "machine",
    name: "lowland/machine",
    entrypoints: ["lowland/machine"],
    readme: false,
    description: "Linux virtual machines, their virtio devices, and networks.",
    groups: [
      {
        title: "Boot a machine",
        description: "Configure CPUs and boot assets, start Linux, and control its lifecycle.",
        symbols: [
          "bootMachine",
          "BootMachineOptions",
          "Machine",
          "MachineExit",
          "PowerOptions",
          "MachinePanicError",
          "bootConsole",
        ],
      },
      {
        title: "Attach devices",
        description: "Add block storage, consoles, filesystems, entropy, networks, and sockets.",
        symbols: [
          "Device",
          "blockDevice",
          "BlockStorage",
          "diskStorage",
          "DiskSource",
          "DiskStorageOptions",
          "DiskFileHandle",
          "consoleDevice",
          "ConsoleDevice",
          "entropyDevice",
          "fileSystemDevice",
          "FS",
          "FSAttributes",
          "FSCreateContext",
          "FSDirectoryEntry",
          "FSDeviceOptions",
          "SystemError",
          "ErrnoCode",
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
        title: "Connect networks",
        description:
          "Put machines on a network that reaches each other, the host, or an HTTP fetch adapter. The kernel configures it from ip=, with no guest agent.",
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
        title: "Run devices in workers",
        description: "Serve a device from a worker so its storage I/O stays off the main thread.",
        symbols: ["Endpoint", "serveDevice", "workerDevice"],
      },
      {
        title: "Write plugins",
        description: "Contribute devices, kernel arguments, and lifecycle hooks to a machine.",
        symbols: [
          "MachinePlugin",
          "MachinePluginInput",
          "MachinePluginProvider",
          "machinePlugin",
          "MachineSetup",
          "KernelArguments",
          "MachineDevices",
        ],
      },
    ],
  },
  {
    slug: "guest",
    name: "lowland/guest",
    entrypoints: ["lowland/guest", "lowland/node", "lowland/browser"],
    readme: false,
    description: "A bootable Linux guest with processes and files, and its host adapters.",
    groups: [
      {
        title: "Start a guest",
        description:
          "Create the guest plugin, give it a mount table to boot, and use its high-level API.",
        symbols: [
          "guestAgent",
          "GuestAgent",
          "GuestAgentOptions",
          "Mount",
          "MountSource",
          "GuestBoot",
          "GuestBootError",
          "RunResult",
        ],
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
        symbols: ["MountOptions", "Unmount", "MountFlags", "UnmountFlags"],
      },
      {
        title: "Reach the host's network",
        description:
          "Give a network from lowland/machine the host's sockets and resolver. Import nodeNetwork from lowland/node.",
        symbols: ["nodeNetwork"],
      },
      {
        title: "Share host directories",
        description:
          "Expose a host directory to the guest. Import NodeFS from lowland/node and BrowserFS from lowland/browser.",
        symbols: ["NodeFS", "NodeFSOptions", "BrowserFS"],
      },
      {
        title: "Handle errors",
        description: "Distinguish guest system errors from protocol failures.",
        symbols: ["SystemError", "ProtocolError"],
      },
    ],
  },
  {
    slug: "image",
    name: "lowland/image",
    entrypoints: ["lowland/image", "lowland/image/build"],
    readme: false,
    description: "The canonical system image, and a builder for your own.",
    groups: [
      {
        title: "Attach an image",
        description: "Attach the canonical image, or your own, as a machine's root.",
        symbols: ["rootImage", "ImageSource", "RootImageOptions", "ImageFileHandle"],
      },
      {
        title: "Build an image",
        description:
          "Build an image from apk packages and host files in Node. Import buildImage from lowland/image/build.",
        symbols: [
          "buildImage",
          "BuildImageOptions",
          "ImageFile",
          "ImageFormat",
          "ImageCompression",
          "PackageRepository",
        ],
      },
    ],
  },
] as const;

export type ReferenceSection = (typeof referenceSections)[number];

export function referenceSymbolId(name: string): string {
  return name.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}

export function referenceGroupId(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(^-|-$)/g, "");
}

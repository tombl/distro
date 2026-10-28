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
        description: "Boot a machine with an image, a mount table, and a network.",
        symbols: ["Linux", "LinuxOptions"],
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
          "VsockListener",
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
        symbols: ["Endpoint", "serveDevice", "serveDeviceError", "workerDevice"],
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
          "MachineInitramfs",
        ],
      },
      {
        title: "Handle errors",
        description:
          "The errno error of guest system calls and filesystem backends, and kernel panics.",
        symbols: ["SystemError", "ErrnoCode", "MachinePanicError"],
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
        symbols: [
          "SpawnOptions",
          "RunOptions",
          "ChildProcess",
          "CommandStatus",
          "exitCode",
          "Signal",
          "StdioSpec",
          "TerminalSize",
        ],
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
        description:
          "A broken connection to the guest agent. A failed system call is a SystemError from lowland/machine.",
        symbols: ["ProtocolError"],
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
        symbols: ["rootImage", "ImageSource", "ImageFileHandle"],
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
        ],
      },
    ],
  },
] as const;

export type ReferenceSection = (typeof referenceSections)[number];

// Every export is documented once, on the page of the section that groups it.
// Another section that re-exports it links there instead.
export const referenceHomes: ReadonlyMap<string, string> = (() => {
  const homes = new Map<string, string>();
  for (const section of referenceSections) {
    for (const group of section.groups) {
      for (const symbol of group.symbols) {
        const home = homes.get(symbol);
        if (home) throw new Error(`${symbol} is grouped in both ${home} and ${section.slug}`);
        homes.set(symbol, section.slug);
      }
    }
  }
  return homes;
})();

export function referenceSymbolId(name: string): string {
  return name.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}

export function referenceGroupId(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(^-|-$)/g, "");
}

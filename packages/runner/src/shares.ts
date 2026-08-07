import { type VirtioDevice, fileSystemDevice } from "@tombl/linux";
import { FS as NodeFileSystem } from "@tombl/linux-guest/node";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export interface ShareArgument {
  value: string;
  readOnly: boolean;
}

export interface ConfiguredShares {
  devices: VirtioDevice[];
  cmdline: string;
}

interface Share {
  host: string;
  guest: string;
  readOnly: boolean;
  tag: string;
}

function parse_share(argument: ShareArgument, index: number): Share {
  const separator = argument.value.lastIndexOf(":");
  if (separator <= 0 || separator === argument.value.length - 1) {
    throw new Error(`share must use HOST:GUEST syntax: ${argument.value}`);
  }

  const host_argument = argument.value.slice(0, separator);
  const guest_argument = argument.value.slice(separator + 1);
  if (!guest_argument.startsWith("/")) {
    throw new Error(`share guest path must be absolute: ${guest_argument}`);
  }
  if (/[\x00-\x1f\x7f]/u.test(guest_argument)) {
    throw new Error("share guest path must not contain control characters");
  }

  let host: string;
  try {
    host = realpathSync(host_argument);
  } catch (error) {
    throw new Error(`cannot resolve shared host path ${host_argument}`, { cause: error });
  }
  if (!statSync(host).isDirectory()) {
    throw new Error(`shared host path is not a directory: ${host_argument}`);
  }

  return {
    host,
    guest: path.posix.normalize(guest_argument),
    readOnly: argument.readOnly,
    tag: `wasmfs${index}`,
  };
}

/** Configure Node-backed virtio-fs devices and their init command-line records. */
export function configureShares(arguments_: ShareArgument[]): ConfiguredShares {
  const shares = arguments_.map(parse_share);
  const targets = new Set<string>();
  for (const share of shares) {
    if (targets.has(share.guest)) {
      throw new Error(`multiple shares target the same guest path: ${share.guest}`);
    }
    targets.add(share.guest);
  }

  const devices = shares.map((share) => {
    const filesystem = new NodeFileSystem(share.host, { readOnly: share.readOnly });
    return fileSystemDevice(filesystem, {
      tag: share.tag,
      cache: false,
    });
  });
  const cmdline = shares
    .map((share) => {
      const mode = share.readOnly ? "ro" : "rw";
      const guest = Buffer.from(share.guest, "utf8").toString("base64");
      return `wasm.share=${share.tag},${mode},${guest}`;
    })
    .join(" ");
  return { devices, cmdline };
}

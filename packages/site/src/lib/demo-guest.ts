// The shared machine behind a docs page's runnable examples. Every example on
// a page addresses the same guest, and nothing boots until the reader first
// presses run, so pages that are only read never download the boot assets.
import { entropyDevice, spawnGuest, type Guest } from "@tombl/linux-guest";

async function fetchBytes(path: string) {
  let response = await fetch(path);
  if (!response.ok) throw new Error(`failed to fetch ${path}: ${response.status}`);
  if (path.endsWith(".gz") && response.headers.get("Content-Encoding") !== "gzip") {
    if (!response.body) throw new Error(`failed to read ${path}`);
    response = new Response(response.body.pipeThrough(new DecompressionStream("gzip")));
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function boot(): Promise<Guest> {
  if (!globalThis.crossOriginIsolated) {
    throw new Error("this page is not cross-origin isolated");
  }

  const [initramfs, rootfs] = await Promise.all([
    fetchBytes("/initramfs.cpio.gz"),
    fetchBytes("/rootfs.squashfs.gz"),
  ]);

  const guest = await spawnGuest({
    cpus: Math.min(navigator.hardwareConcurrency, 4),
    assets: { initramfs, rootfs },
    devices: [entropyDevice()],
  });
  void guest.machine.bootConsole.pipeTo(new WritableStream()).catch(() => {});
  return guest;
}

let booting: Promise<Guest> | undefined;

// A failed boot clears the slot so the next press retries instead of
// replaying the cached rejection.
export function demoGuest(): Promise<Guest> {
  booting ??= boot().catch((error) => {
    booting = undefined;
    throw error;
  });
  return booting;
}

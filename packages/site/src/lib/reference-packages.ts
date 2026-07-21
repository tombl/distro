export const referencePackages = [
  {
    slug: "linux",
    name: "@tombl/linux",
    description: "Low-level Linux virtual machine and virtio device primitives.",
    npm: "https://www.npmjs.com/package/@tombl/linux",
  },
  {
    slug: "linux-guest",
    name: "@tombl/linux-guest",
    description: "A bootable Linux guest with processes, files, and networking.",
    npm: "https://www.npmjs.com/package/@tombl/linux-guest",
  },
] as const;

export type ReferencePackage = (typeof referencePackages)[number];

export function referenceSymbolId(name: string): string {
  return name.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}

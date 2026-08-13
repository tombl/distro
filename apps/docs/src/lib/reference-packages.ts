export const referencePackages = [
  {
    slug: "kernel",
    name: "@lowland/kernel",
    description: "Low-level Linux virtual machine and virtio device primitives.",
    npm: "https://www.npmjs.com/package/@lowland/kernel",
  },
  {
    slug: "linux-guest",
    name: "@lowland/guest",
    description: "A bootable Linux guest with processes, files, and networking.",
    npm: "https://www.npmjs.com/package/@lowland/guest",
  },
] as const;

export type ReferencePackage = (typeof referencePackages)[number];

export function referenceSymbolId(name: string): string {
  return name.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}

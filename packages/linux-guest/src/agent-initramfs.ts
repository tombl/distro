import type { Asset } from "./platform.ts";

// The agent initramfs is an uncompressed newc archive, and every newc member
// header starts with this magic. Checking for it turns an asset URL that a
// bundler or dev server answered with an HTML page into a clear error instead
// of a kernel that finds no /init.
const NEWC_MAGIC = "070701";

/** @internal Throws unless `asset`, loaded from `url`, is a newc archive. */
export function check_agent_initramfs(url: URL, { bytes, content_type }: Asset) {
  const type = content_type?.split(";")[0]?.trim().toLowerCase() || undefined;
  const magic = new TextDecoder().decode(bytes.subarray(0, NEWC_MAGIC.length));
  if (type === "text/html" || magic !== NEWC_MAGIC) {
    const subject =
      url.protocol === "file:"
        ? `${decodeURIComponent(url.pathname)} is not`
        : `${url} did not return`;
    const got = type ? `${type}, ${bytes.byteLength} bytes` : `${bytes.byteLength} bytes`;
    throw new Error(`${subject} a guest agent initramfs: got ${got}`);
  }
}

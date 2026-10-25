import type { Asset } from "./platform.ts";

// The agent image is a GPT disk, whose header starts at LBA 1. Checking for it
// turns an asset URL that a bundler or dev server answered with an HTML page
// into a clear error instead of a failed boot.
const SECTOR_SIZE = 512;
const GPT_SIGNATURE = "EFI PART";
const MINIMUM_SIZE = 2 * SECTOR_SIZE;

/** @internal Throws unless `asset`, loaded from `url`, is a GPT disk image. */
export function check_agent_image(url: URL, { bytes, content_type }: Asset) {
  const type = content_type?.split(";")[0]?.trim().toLowerCase() || undefined;
  const signature = new TextDecoder().decode(
    bytes.subarray(SECTOR_SIZE, SECTOR_SIZE + GPT_SIGNATURE.length),
  );
  if (type === "text/html" || bytes.byteLength < MINIMUM_SIZE || signature !== GPT_SIGNATURE) {
    const subject =
      url.protocol === "file:"
        ? `${decodeURIComponent(url.pathname)} is not`
        : `${url} did not return`;
    const got = type ? `${type}, ${bytes.byteLength} bytes` : `${bytes.byteLength} bytes`;
    throw new Error(`${subject} a guest agent disk image: got ${got}`);
  }
}

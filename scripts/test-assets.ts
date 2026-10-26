// The one way tests find Nix-built assets: a directory with a fixed layout,
// named by $LOWLAND_TEST_ASSETS. Nix checks set it to a link farm holding only
// what the check needs; outside Nix, the first use builds `.#test-assets`,
// which holds everything. distro/npm/test-assets.nix lists the layout.
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
let directory: Promise<string> | undefined;

export function testAssets(): Promise<string> {
  const configured = process.env.LOWLAND_TEST_ASSETS;
  if (configured) return Promise.resolve(configured);
  directory ??= promisify(execFile)(
    "nix",
    ["build", `${repository}#test-assets`, "--no-link", "--print-out-paths"],
    { encoding: "utf8" },
  ).then(
    ({ stdout }) => stdout.trim(),
    (error) => {
      directory = undefined;
      throw error;
    },
  );
  return directory;
}

export async function testAsset(name: string): Promise<string> {
  return join(await testAssets(), name);
}

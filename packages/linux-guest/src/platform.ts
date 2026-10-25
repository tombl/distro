// The seam between web APIs and Node builtins. Keeping the runtime probe here
// prevents guest integrations from depending directly on either environment.

/** @internal A packaged asset and the content type it was served with, if any. */
export interface Asset {
  bytes: Uint8Array<ArrayBuffer>;
  content_type: string | null;
}

interface Platform {
  load_asset(url: URL): Promise<Asset>;
}

/** @internal */
export const web: Platform = {
  async load_asset(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`failed to load guest asset: ${response.status}`);
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      content_type: response.headers.get("content-type"),
    };
  },
};

interface GetBuiltinModule {
  (id: "node:fs/promises"): {
    readFile(path: URL): Promise<Uint8Array<ArrayBuffer>>;
  };
}

interface NodeProcess {
  getBuiltinModule?: GetBuiltinModule;
}

function node(getBuiltinModule: GetBuiltinModule): Platform {
  const { readFile } = getBuiltinModule("node:fs/promises");
  return {
    async load_asset(url) {
      return { bytes: await readFile(url), content_type: null };
    },
  };
}

const getBuiltinModule = (globalThis as { process?: NodeProcess }).process?.getBuiltinModule;

/** @internal */
export const platform: Platform = getBuiltinModule ? node(getBuiltinModule) : web;

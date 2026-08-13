// The seam between web APIs and Node builtins. Keeping the runtime probe here
// prevents guest integrations from depending directly on either environment.

interface Platform {
  load_asset(url: URL): Promise<Uint8Array<ArrayBuffer>>;
}

const web: Platform = {
  async load_asset(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`failed to load guest asset: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
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
  return { load_asset: readFile };
}

const getBuiltinModule = (globalThis as { process?: NodeProcess }).process?.getBuiltinModule;

/** @internal */
export const platform: Platform = getBuiltinModule ? node(getBuiltinModule) : web;

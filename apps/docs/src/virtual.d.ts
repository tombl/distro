declare module "virtual:example-runtime" {
  /** The URL path the package files are served under. */
  export const base: string;
  /** Resolves the package names to their files under `base`. */
  export const importMap: { imports: Record<string, string> };
  /** Every declaration file, relative to `base`, for the editor's type checker. */
  export const typeFiles: string[];
}

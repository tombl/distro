/** Names an example and carries its current text. */
interface Document {
  file: string;
  text: string;
}

/** A request from the page to the example type checker. */
export type TypesRequest =
  | { type: "init"; base: string; imports: Record<string, string>; typeFiles: string[] }
  | ({ type: "diagnostics" } & Document)
  | ({ type: "completions"; offset: number } & Document)
  | ({ type: "details"; offset: number; name: string } & Document)
  | ({ type: "quickInfo"; offset: number } & Document)
  | ({ type: "transpile" } & Document);

export interface Diagnostic {
  start: number;
  length: number;
  message: string;
  severity: "error" | "warning";
}

export interface Completions {
  /** Where the completed identifier starts. */
  start: number;
  entries: { name: string; kind: string; insertText?: string }[];
}

export interface Details {
  signature: string;
  documentation: string;
}

export interface QuickInfo extends Details {
  start: number;
  length: number;
}

export interface TypesResponse {
  id: number;
  result: null | Diagnostic[] | Completions | Details | QuickInfo | string;
  error?: string;
}

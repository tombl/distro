// A TypeScript language service for the example editors. It checks each
// example against the published declaration files, and answers completion and
// hover requests from the page.
import ts from "typescript";

import type { TypesRequest, TypesResponse } from "./example-types-protocol";

// The standard library, one lazily loaded chunk per file, so only the files the
// examples' `lib` setting references are fetched.
const libraries = import.meta.glob<string>("../../node_modules/typescript/lib/lib.*.d.ts", {
  query: "?raw",
  import: "default",
});
const libraryFiles = new Map(
  Object.entries(libraries).map(([path, load]) => [path.slice(path.lastIndexOf("/") + 1), load]),
);
const rootLibraries = [
  "lib.esnext.d.ts",
  "lib.dom.d.ts",
  "lib.dom.iterable.d.ts",
  "lib.dom.asynciterable.d.ts",
];

const files = new Map<string, { text: string; version: number }>();
const examples = new Set<string>();

function addFile(path: string, text: string) {
  const version = (files.get(path)?.version ?? 0) + 1;
  files.set(path, { text, version });
}

async function loadLibraries() {
  const pending = [...rootLibraries];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const load = libraryFiles.get(name);
    if (!load) continue;
    const text = await load();
    addFile(`/lib/${name}`, text);
    for (const [, reference] of text.matchAll(/\/\/\/\s*<reference lib="([^"]+)"/g)) {
      pending.push(`lib.${reference.toLowerCase()}.d.ts`);
    }
  }
}

async function loadPackages(base: string, typeFiles: string[]) {
  await Promise.all(
    typeFiles.map(async (file) => {
      const response = await fetch(`${base}/${file}`);
      if (!response.ok) throw new Error(`${file}: ${response.status}`);
      addFile(`/node_modules/${file}`, await response.text());
    }),
  );
}

function compilerOptions(imports: Record<string, string>, base: string): ts.CompilerOptions {
  const paths: Record<string, string[]> = {};
  for (const [specifier, url] of Object.entries(imports)) {
    paths[specifier] = [url.replace(`${base}/`, "/node_modules/").replace(/\.js$/, ".d.ts")];
  }
  return {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: rootLibraries,
    strict: true,
    // Examples may be JavaScript, which the service only reads with allowJs.
    allowJs: true,
    checkJs: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    paths,
  };
}

function createService(options: ts.CompilerOptions) {
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...examples],
    getScriptVersion: (path) => String(files.get(path)?.version ?? 0),
    getScriptSnapshot: (path) => {
      const file = files.get(path);
      return file && ts.ScriptSnapshot.fromString(file.text);
    },
    getCurrentDirectory: () => "/",
    getDefaultLibFileName: () => "/lib/lib.d.ts",
    fileExists: (path) => files.has(path),
    readFile: (path) => files.get(path)?.text,
    directoryExists: (path) => [...files.keys()].some((file) => file.startsWith(`${path}/`)),
  };
  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

const flatten = (text: string | ts.DiagnosticMessageChain) =>
  ts.flattenDiagnosticMessageText(text, "\n");
const display = (parts: ts.SymbolDisplayPart[] | undefined) => ts.displayPartsToString(parts);

function handle(request: TypesRequest, service: ts.LanguageService): TypesResponse["result"] {
  if (request.type === "init") return null;
  if (files.get(request.file)?.text !== request.text) addFile(request.file, request.text);
  examples.add(request.file);
  switch (request.type) {
    case "diagnostics": {
      const diagnostics = [
        ...service.getSyntacticDiagnostics(request.file),
        ...service.getSemanticDiagnostics(request.file),
      ];
      return diagnostics.map((diagnostic) => ({
        start: diagnostic.start ?? 0,
        length: diagnostic.length ?? 0,
        message: flatten(diagnostic.messageText),
        severity: diagnostic.category === ts.DiagnosticCategory.Error ? "error" : "warning",
      }));
    }
    case "completions": {
      const { text } = request;
      const completions = service.getCompletionsAtPosition(request.file, request.offset, {
        includeCompletionsWithInsertText: true,
        includeCompletionsForModuleExports: false,
      });
      if (!completions) return null;
      let start = request.offset;
      while (start > 0 && /[\w$]/.test(text[start - 1])) start--;
      const prefix = text.slice(start, request.offset).toLowerCase();
      const entries = completions.entries
        .filter((entry) => entry.name.toLowerCase().startsWith(prefix))
        .toSorted((a, b) => a.sortText.localeCompare(b.sortText) || a.name.localeCompare(b.name))
        .slice(0, 50)
        .map((entry) => ({ name: entry.name, kind: entry.kind, insertText: entry.insertText }));
      return { start, entries };
    }
    case "details": {
      const details = service.getCompletionEntryDetails(
        request.file,
        request.offset,
        request.name,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      return details
        ? {
            signature: display(details.displayParts),
            documentation: display(details.documentation),
          }
        : null;
    }
    case "quickInfo": {
      const info = service.getQuickInfoAtPosition(request.file, request.offset);
      if (!info) return null;
      return {
        start: info.textSpan.start,
        length: info.textSpan.length,
        signature: display(info.displayParts),
        documentation: display(info.documentation),
      };
    }
  }
}

type InitRequest = Extract<TypesRequest, { type: "init" }>;

let initRequest: InitRequest | undefined;
let ready: Promise<ts.LanguageService> | undefined;

// A failed download is forgotten, so the next request retries it.
function languageService(request?: InitRequest): Promise<ts.LanguageService> {
  if (request) initRequest = request;
  if (!initRequest) return Promise.reject(new Error("the type checker was not initialized"));
  const { base, typeFiles, imports } = initRequest;
  if (!ready) {
    const attempt = (async () => {
      await Promise.all([loadLibraries(), loadPackages(base, typeFiles)]);
      return createService(compilerOptions(imports, base));
    })();
    ready = attempt;
    attempt.catch(() => {
      if (ready === attempt) ready = undefined;
    });
  }
  return ready;
}

addEventListener("message", async (event: MessageEvent<TypesRequest & { id: number }>) => {
  const request = event.data;
  let response: TypesResponse;
  try {
    if (request.type === "init") {
      await languageService(request);
      response = { id: request.id, result: null };
    } else {
      response = { id: request.id, result: handle(request, await languageService()) };
    }
  } catch (error) {
    response = { id: request.id, result: null, error: String(error) };
  }
  postMessage(response);
});

import { File, type FileContents } from "@pierre/diffs";
import { Editor, type Marker, type Position } from "@pierre/diffs/edit";
import { base, importMap, typeFiles } from "virtual:example-runtime";

import type {
  Completions,
  Details,
  Diagnostic,
  QuickInfo,
  TypesRequest,
  TypesResponse,
} from "./example-types-protocol";

// Matches the static code block the editor replaces: the docs' monospace
// font and size, the code surface, and its padding.
const css = `
  :host {
    --diffs-font-family: var(--font-mono, ui-monospace, monospace);
    --diffs-font-size: 0.9375rem;
    --diffs-line-height: 1.5;
    --diffs-bg: var(--surface);
    /* The current line would be tinted with the theme's yellow. */
    --diffs-bg-selection-override: var(--diffs-bg);
  }
  /* The editor places its caret as if each line were padded by 1ch. */
  pre {
    padding: 1rem calc(1rem - 1ch);
  }
  code {
    padding: 0;
  }
`;

// One type checker serves every example on the page. It starts the first time
// a reader focuses an example, since it downloads TypeScript.
let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, (response: TypesResponse) => void>();

function request<T>(message: TypesRequest): Promise<T | null> {
  if (!worker) {
    worker = new Worker(new URL("./example-types.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<TypesResponse>) => {
      pending.get(event.data.id)?.(event.data);
      pending.delete(event.data.id);
    });
    // A worker that fails to start answers nothing, so the next request
    // starts another.
    worker.addEventListener("error", (event) => {
      console.warn("example type checker failed:", event.message);
      worker = undefined;
      for (const [id, resolve] of pending) resolve({ id, result: null });
      pending.clear();
    });
    void request({ type: "init", base, imports: importMap.imports, typeFiles });
  }
  const id = nextId++;
  worker.postMessage({ ...message, id });
  return new Promise((resolve) => {
    pending.set(id, (response) => {
      if (response.error) console.warn("example type checker:", response.error);
      resolve(response.result as T | null);
    });
  });
}

/** Compiles an example for a browser that lacks `using` declarations, or
 *  returns null if the type checker could not start. */
export function transpile(text: string, lang: string): Promise<string | null> {
  return request<string>({ type: "transpile", file: `transpile.${lang}`, text });
}

function positionAt(text: string, offset: number): Position {
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, character: offset - (before.lastIndexOf("\n") + 1) };
}

function offsetAt(text: string, { line, character }: Position): number {
  let offset = 0;
  for (let index = 0; index < line; index++) offset = text.indexOf("\n", offset) + 1;
  return offset + character;
}

function debounce(delay: number, callback: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Object.assign(
    () => {
      clearTimeout(timer);
      timer = setTimeout(callback, delay);
    },
    { cancel: () => clearTimeout(timer) },
  );
}

let examples = 0;

// The rendered code lives in the shadow root of the component's container.
function shadowOf(host: HTMLElement) {
  return host.querySelector("diffs-container")?.shadowRoot ?? undefined;
}

export function mountEditor(
  example: HTMLElement,
  container: HTMLElement,
  code: string,
  lang: string,
) {
  const path = `/example-${examples++}.${lang}`;
  const file: FileContents = { name: path.slice(1), contents: code };
  const host = document.createElement("div");
  host.className = "example-editor";
  let rendered = false;

  const instance = new File({
    theme: { light: "github-light-default", dark: "github-dark-default" },
    disableFileHeader: true,
    disableLineNumbers: true,
    overflow: "scroll",
    unsafeCSS: css,
    onPostRender() {
      if (!host.classList.contains("rendering")) return;
      rendered = true;
      host.classList.remove("rendering");
      for (const child of [...container.children]) if (child !== host) child.remove();
    },
  });

  let checking = false;
  const check = debounce(300, async () => {
    const text = editor.getText();
    const diagnostics = await request<Diagnostic[]>({ type: "diagnostics", file: path, text });
    if (!diagnostics || editor.getText() !== text) return;
    editor.setMarkers(
      diagnostics.map(
        (diagnostic): Marker => ({
          start: positionAt(text, diagnostic.start),
          end: positionAt(text, diagnostic.start + Math.max(diagnostic.length, 1)),
          severity: diagnostic.severity,
          message: diagnostic.message,
        }),
      ),
    );
  });

  const completion = completionList(example, host, {
    caret: () => {
      const selection = editor.getViewState().selections?.[0];
      if (!selection) return undefined;
      const { start, end } = selection;
      if (start.line !== end.line || start.character !== end.character) return undefined;
      return offsetAt(editor.getText(), end);
    },
    complete: (offset) =>
      request<Completions>({ type: "completions", file: path, text: editor.getText(), offset }),
    details: (offset, name) =>
      request<Details>({ type: "details", file: path, text: editor.getText(), offset, name }),
    insert: (start, end, text) => {
      const document = editor.getText();
      editor.applyEdits([
        {
          range: { start: positionAt(document, start), end: positionAt(document, end) },
          newText: text,
        },
      ]);
      const caret = positionAt(editor.getText(), start + text.length);
      editor.setSelections([{ start: caret, end: caret, direction: "none" }]);
    },
  });

  const editor = new Editor("file", {
    onFocus() {
      if (checking) return;
      checking = true;
      check();
    },
    onBlur: () => completion.close(),
    onChange(event) {
      if (checking) check();
      completion.changed(event.changes.map((change) => change.text).join(""));
    },
  });

  // The editor measures its font when it renders, so it renders in place,
  // invisibly over the static block, which it then replaces.
  host.classList.add("rendering");
  container.append(host);
  instance.render({ file, containerWrapper: host });
  editor.edit(instance);
  hoverInfo(example, host, {
    offset: (line, character) => offsetAt(editor.getText(), { line, character }),
    quickInfo: async (offset) => {
      if (!checking) return null;
      return request<QuickInfo>({ type: "quickInfo", file: path, text: editor.getText(), offset });
    },
  });

  // Until its first render, the editor's document is still empty.
  return { getText: () => (rendered ? editor.getText() : code) };
}

interface CompletionSource {
  caret(): number | undefined;
  complete(offset: number): Promise<Completions | null>;
  details(offset: number, name: string): Promise<Details | null>;
  insert(start: number, end: number, text: string): void;
}

function completionList(example: HTMLElement, host: HTMLElement, source: CompletionSource) {
  const list = document.createElement("div");
  list.className = "example-completions";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  const detail = document.createElement("div");
  detail.className = "example-completion-detail";
  example.append(list);

  let state:
    | { start: number; offset: number; entries: Completions["entries"]; selected: number }
    | undefined;
  let generation = 0;

  function close() {
    reopen.cancel();
    generation++;
    state = undefined;
    list.hidden = true;
  }

  function place() {
    const caret = shadowOf(host)?.querySelector("[data-caret]")?.getBoundingClientRect();
    const frame = example.getBoundingClientRect();
    if (!caret) return;
    list.style.insetBlockStart = `${caret.bottom - frame.top + 2}px`;
    list.style.insetInlineStart = `${Math.max(0, caret.left - frame.left - 8)}px`;
  }

  const describe = debounce(80, async () => {
    if (!state) return;
    const current = state;
    const entry = current.entries[current.selected];
    const details = await source.details(current.offset, entry.name);
    if (state !== current || current.entries[current.selected] !== entry) return;
    detail.textContent = details?.signature ?? "";
    detail.hidden = !details?.signature;
  });

  function render() {
    if (!state) return;
    const { entries, selected } = state;
    list.replaceChildren(
      ...entries.map((entry, index) => {
        const item = document.createElement("div");
        item.className = "example-completion";
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(index === selected));
        const name = document.createElement("span");
        name.textContent = entry.name;
        const kind = document.createElement("span");
        kind.className = "example-completion-kind";
        kind.textContent = entry.kind;
        item.append(name, kind);
        item.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          if (state) state.selected = index;
          accept();
        });
        return item;
      }),
      detail,
    );
    list.children[selected]?.scrollIntoView({ block: "nearest" });
    detail.hidden = true;
    describe();
  }

  async function open() {
    const offset = source.caret();
    if (offset === undefined) return close();
    const id = ++generation;
    const result = await source.complete(offset);
    if (id !== generation) return;
    if (!result || result.entries.length === 0) return close();
    const typed = offset - result.start;
    if (result.entries.length === 1 && result.entries[0].name.length === typed) return close();
    state = { start: result.start, offset, entries: result.entries, selected: 0 };
    list.hidden = false;
    render();
    place();
  }

  function accept() {
    if (!state) return;
    const entry = state.entries[state.selected];
    const offset = source.caret() ?? state.offset;
    const { start } = state;
    close();
    source.insert(start, offset, entry.insertText ?? entry.name);
  }

  const reopen = debounce(60, () => void open());

  // Runs before the editor's own key handling, which is inside its shadow root.
  host.addEventListener(
    "keydown",
    (event) => {
      if (event.key === " " && event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        void open();
        return;
      }
      if (!state) return;
      const keys: Record<string, () => void> = {
        ArrowDown: () => (state!.selected = (state!.selected + 1) % state!.entries.length),
        ArrowUp: () =>
          (state!.selected = (state!.selected - 1 + state!.entries.length) % state!.entries.length),
        Enter: accept,
        Tab: accept,
        Escape: close,
      };
      const action = keys[event.key];
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      action();
      if (event.key.startsWith("Arrow")) render();
    },
    { capture: true },
  );

  return {
    close,
    changed(text: string) {
      if (/^[A-Za-z_$.]$/.test(text) || (state && /^[\w$]?$/.test(text))) reopen();
      else close();
    },
  };
}

interface HoverSource {
  offset(line: number, character: number): number;
  quickInfo(offset: number): Promise<QuickInfo | null>;
}

// Shows the type of the identifier under the pointer, once the type checker is
// running.
function hoverInfo(example: HTMLElement, host: HTMLElement, source: HoverSource) {
  const popup = document.createElement("div");
  popup.className = "example-hover";
  popup.hidden = true;
  example.append(popup);
  let point: { x: number; y: number } | undefined;
  let shown: number | undefined;

  const hide = () => {
    popup.hidden = true;
    shown = undefined;
  };

  const lookup = debounce(350, async () => {
    const root = shadowOf(host);
    if (!point || !root) return;
    const caret = document.caretPositionFromPoint?.(point.x, point.y, { shadowRoots: [root] });
    // Each token's span records the column it starts at.
    const token = caret?.offsetNode.parentElement?.closest<HTMLElement>("[data-char]");
    const line = token?.closest<HTMLElement>("[data-line]");
    if (!caret || !token || !line) return hide();
    const character = Number(token.dataset.char) + caret.offset;
    const offset = source.offset(Number(line.dataset.line) - 1, character);
    const info = await source.quickInfo(offset);
    if (!info || !info.signature) return hide();
    if (shown === info.start && !popup.hidden) return;
    shown = info.start;
    popup.replaceChildren();
    const signature = document.createElement("code");
    signature.textContent = info.signature;
    popup.append(signature);
    if (info.documentation) {
      const documentation = document.createElement("p");
      documentation.textContent = info.documentation.split("\n\n")[0];
      popup.append(documentation);
    }
    const frame = example.getBoundingClientRect();
    const lineBox = line.getBoundingClientRect();
    popup.hidden = false;
    popup.style.insetBlockEnd = `${frame.bottom - lineBox.top + 2}px`;
    popup.style.insetInlineStart = `${Math.max(0, point.x - frame.left - 16)}px`;
  });

  host.addEventListener("pointermove", (event) => {
    point = { x: event.clientX, y: event.clientY };
    lookup();
  });
  host.addEventListener("pointerleave", () => {
    point = undefined;
    hide();
  });
  host.addEventListener("keydown", hide);
}

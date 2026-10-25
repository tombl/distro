import type { FrameMessage, RunMessage } from "./example-protocol";

interface Run {
  frame: HTMLIFrameElement;
  code: string;
  quiet: boolean;
}

const runs = new Map<HTMLElement, Run>();

function parts(example: HTMLElement) {
  return {
    button: example.querySelector<HTMLButtonElement>("[data-example-run]")!,
    output: example.querySelector<HTMLElement>("[data-example-output]")!,
  };
}

function print(example: HTMLElement, level: string, text: string) {
  const { output } = parts(example);
  const run = runs.get(example);
  if (run?.quiet) {
    output.replaceChildren();
    run.quiet = false;
  }
  const line = document.createElement("span");
  line.dataset.level = level;
  // Decoded program output usually ends in a newline of its own.
  line.textContent = `${text.replace(/\n$/, "")}\n`;
  output.append(line);
}

function status(example: HTMLElement, text: string) {
  print(example, "status", text);
}

function finish(example: HTMLElement) {
  const run = runs.get(example);
  if (!run) return;
  runs.delete(example);
  run.frame.remove();
  const { button, output } = parts(example);
  if (run.quiet) output.replaceChildren();
  button.textContent = "Run";
  delete example.dataset.running;
}

async function strip(code: string, lang: string): Promise<string> {
  if (lang !== "ts") return code;
  const { transform } = await import("sucrase");
  return transform(code, { transforms: ["typescript"], disableESTransforms: true }).code;
}

// The example's current text. The editor registers itself here once it loads.
export const sources = new WeakMap<HTMLElement, () => string>();

async function run(example: HTMLElement) {
  finish(example);
  const { button, output } = parts(example);
  output.hidden = false;
  output.replaceChildren();
  button.textContent = "Stop";
  example.dataset.running = "";

  const source = sources.get(example)?.() ?? example.dataset.source ?? "";
  let code;
  try {
    code = await strip(source, example.dataset.lang ?? "ts");
  } catch (error) {
    print(example, "error", String(error instanceof Error ? error.message : error));
    button.textContent = "Run";
    delete example.dataset.running;
    return;
  }

  const frame = document.createElement("iframe");
  frame.src = "/example-frame/";
  frame.title = "Example runner";
  frame.hidden = true;
  frame.allow = "cross-origin-isolated";
  // The placeholder stays until the example prints something.
  status(example, "Running...");
  runs.set(example, { frame, code, quiet: true });
  example.append(frame);
}

addEventListener("message", (event: MessageEvent<FrameMessage>) => {
  if (event.origin !== location.origin) return;
  for (const [example, run] of runs) {
    if (run.frame.contentWindow !== event.source) continue;
    const message = event.data;
    if (message.type === "ready") {
      run.frame.contentWindow!.postMessage(
        { type: "run", code: run.code } satisfies RunMessage,
        location.origin,
      );
    } else if (message.type === "output") {
      print(example, message.level, message.text);
    } else if (message.type === "done") {
      const quiet = run.quiet;
      finish(example);
      if (quiet) status(example, "The example finished without printing anything.");
    }
  }
});

// The editor loads once an example comes into view, so the code is editable by
// the time a reader reaches it.
const visible = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const example = entry.target as HTMLElement;
      visible.unobserve(example);
      void import("./example-editor").then(({ mountEditor }) => {
        const code = example.querySelector<HTMLElement>("[data-example-code]")!;
        const editor = mountEditor(
          example,
          code,
          example.dataset.source ?? "",
          example.dataset.lang ?? "ts",
        );
        sources.set(example, editor.getText);
      });
    }
  },
  { rootMargin: "50% 0px" },
);

for (const example of document.querySelectorAll<HTMLElement>("[data-example]")) {
  visible.observe(example);
  parts(example).button.hidden = false;
  parts(example).button.addEventListener("click", () => {
    if (runs.has(example)) {
      finish(example);
      status(example, "Stopped.");
    } else {
      void run(example);
    }
  });
}

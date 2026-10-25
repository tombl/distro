import type { FrameMessage, RunMessage } from "./example-protocol";

function post(message: FrameMessage) {
  parent.postMessage(message, location.origin);
}

// Formats console arguments roughly the way Node prints them, which is what
// the examples are written against.
function format(value: unknown): string {
  if (typeof value === "string") return value;
  // The stack would only point into the frame's blob URL.
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const items = Array.from(value as unknown as ArrayLike<number>);
    const shown = items.slice(0, 100).join(", ");
    const more = items.length > 100 ? `, ... ${items.length - 100} more items` : "";
    return `${value.constructor.name}(${items.length}) [ ${shown}${more} ]`;
  }
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value, (_, item) => (typeof item === "bigint" ? `${item}n` : item), 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

for (const level of ["log", "info", "debug", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    // The development server's client logs its connection here too.
    if (import.meta.env.DEV && typeof args[0] === "string" && args[0].startsWith("[vite]")) return;
    post({ type: "output", level, text: args.map(format).join(" ") });
  };
}

addEventListener("error", (event) => {
  post({ type: "output", level: "error", text: format(event.error ?? event.message) });
});
addEventListener("unhandledrejection", (event) => {
  post({ type: "output", level: "error", text: `Uncaught ${format(event.reason)}` });
});

addEventListener("message", async (event: MessageEvent<RunMessage>) => {
  if (event.origin !== location.origin || event.source !== parent) return;
  if (event.data?.type !== "run") return;
  const url = URL.createObjectURL(new Blob([event.data.code], { type: "text/javascript" }));
  try {
    await import(/* @vite-ignore */ url);
    post({ type: "done", ok: true });
  } catch (error) {
    post({ type: "output", level: "error", text: `Uncaught ${format(error)}` });
    post({ type: "done", ok: false });
  } finally {
    URL.revokeObjectURL(url);
  }
});

if (!crossOriginIsolated) {
  post({
    type: "output",
    level: "error",
    text: "This page is not cross-origin isolated, so it cannot boot a machine.",
  });
}
post({ type: "ready" });

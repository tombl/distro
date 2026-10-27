/** Sent by the page to a fresh example frame once it is ready. */
export interface RunMessage {
  type: "run";
  /** The example as JavaScript, with its types stripped. */
  code: string;
}

/** Sent by an example frame to the page that embeds it. */
export type FrameMessage =
  | { type: "ready" }
  | { type: "output"; level: "log" | "info" | "debug" | "warn" | "error"; text: string }
  | { type: "done"; ok: boolean };

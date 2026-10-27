import assert from "node:assert/strict";
import { test } from "node:test";
import { check_agent_initramfs } from "../src/agent-initramfs.ts";
import { web } from "../src/platform.ts";
import { agent_initramfs } from "./assets.ts";

const url = new URL("https://example.com/assets/agent.cpio");

async function load(response: Response) {
  const fetch = async () => response;
  const original = globalThis.fetch;
  globalThis.fetch = fetch as typeof globalThis.fetch;
  try {
    const asset = await web.load_asset(url);
    check_agent_initramfs(url, asset);
    return asset;
  } finally {
    globalThis.fetch = original;
  }
}

test("accepts the packaged agent initramfs", async () => {
  const asset = await load(new Response(new Uint8Array(agent_initramfs)));
  assert.equal(asset.bytes.byteLength, agent_initramfs.byteLength);
});

test("rejects an HTML fallback page", async () => {
  await assert.rejects(
    () => load(new Response("x".repeat(116), { headers: { "content-type": "text/html" } })),
    new Error(`${url} did not return a guest agent initramfs: got text/html, 116 bytes`),
  );
});

test("rejects HTML even when it is a newc archive", async () => {
  await assert.rejects(
    () =>
      load(
        new Response(new Uint8Array(agent_initramfs), {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      ),
    /did not return a guest agent initramfs: got text\/html, \d+ bytes$/,
  );
});

test("rejects bytes that are not a newc archive", async () => {
  await assert.rejects(
    () => load(new Response(new Uint8Array(4096))),
    new Error(`${url} did not return a guest agent initramfs: got 4096 bytes`),
  );
});

test("names a file that is not an initramfs", () => {
  const file = new URL("file:///srv/agent.cpio");
  assert.throws(
    () => check_agent_initramfs(file, { bytes: new Uint8Array(10), content_type: null }),
    new Error("/srv/agent.cpio is not a guest agent initramfs: got 10 bytes"),
  );
});

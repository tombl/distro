import assert from "node:assert/strict";
import { test } from "node:test";
import { check_agent_image } from "../src/agent-image.ts";
import { web } from "../src/platform.ts";
import { agent_disk } from "./assets.ts";

const url = new URL("https://example.com/assets/agent.img");

async function load(response: Response) {
  const fetch = async () => response;
  const original = globalThis.fetch;
  globalThis.fetch = fetch as typeof globalThis.fetch;
  try {
    const asset = await web.load_asset(url);
    check_agent_image(url, asset);
    return asset;
  } finally {
    globalThis.fetch = original;
  }
}

test("accepts the packaged agent image", async () => {
  const asset = await load(new Response(new Uint8Array(agent_disk)));
  assert.equal(asset.bytes.byteLength, agent_disk.byteLength);
});

test("rejects an HTML fallback page", async () => {
  await assert.rejects(
    () => load(new Response("x".repeat(116), { headers: { "content-type": "text/html" } })),
    new Error(`${url} did not return a guest agent disk image: got text/html, 116 bytes`),
  );
});

test("rejects HTML even when it is large", async () => {
  await assert.rejects(
    () =>
      load(
        new Response(new Uint8Array(agent_disk), {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      ),
    /did not return a guest agent disk image: got text\/html, \d+ bytes$/,
  );
});

test("rejects a disk without a GPT header", async () => {
  await assert.rejects(
    () => load(new Response(new Uint8Array(4096))),
    new Error(`${url} did not return a guest agent disk image: got 4096 bytes`),
  );
});

test("names a file that is not a disk image", () => {
  const file = new URL("file:///srv/agent.img");
  assert.throws(
    () => check_agent_image(file, { bytes: new Uint8Array(10), content_type: null }),
    new Error("/srv/agent.img is not a guest agent disk image: got 10 bytes"),
  );
});

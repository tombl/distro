// The main page: the bridge wired to a stub handler that echoes the request
// and streams its body back, keyed on the demanded port.
import { serveGuest } from "@lowland/bridge-site/client";
import { hubOrigin } from "./hub.js";

// One VM page, every guest origin in the family bound lazily on first demand.
// The stub echoes the demanded port so tests can assert the origin->port map.
const bridge = serveGuest({
  hub: hubOrigin,
  fetch: (port) => async (request) => {
    const url = new URL(request.url);
    // A magic path the guest-error test hits: throwing is how a real guest
    // with nothing listening on its port surfaces.
    if (url.pathname === "/boom") throw new Error("nothing listening on guest port " + port);
    const info = JSON.stringify({
      port,
      path: url.pathname + url.search,
      method: request.method,
      body: new TextDecoder().decode(await request.arrayBuffer()),
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(info));
        controller.enqueue(encoder.encode("::chunk::"));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/json", "x-bridge-stub": "yes" },
    });
  },
});

// What specs drive through page.evaluate(); hooks.d.ts types them.
export const hooks = {
  bridgeOrigin: hubOrigin,
  closeBridge: () => bridge.close(),
  iframeCount: () => document.querySelectorAll("iframe").length,
};
Object.assign(globalThis, hooks);

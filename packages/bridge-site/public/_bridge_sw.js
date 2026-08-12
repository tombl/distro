/** @type {MessagePort | null} */
let bridgePort = null;
/** @type {Promise<MessagePort | null> | null} shared in-flight port acquisition */
let acquiring = null;
/** @type {(() => void) | null} wakes the current acquisition when a port lands */
let onPort = null;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", ({ data, ports }) => {
  if (data?.type !== "bridge:port") return;
  bridgePort = ports[0];
  onPort?.();
});

self.addEventListener("fetch", (event) => {
  const { pathname } = new URL(event.request.url);
  // The connecting page only needs to know when it can reload into guest content.
  if (pathname === "/_bridge/status") {
    event.respondWith(Response.json({ connected: bridgePort !== null }));
    return;
  }
  // Everything belongs to the guest site except the bridge's own namespace
  // (/_bridge/* and this script), so hosted content can claim any path — even
  // /sw.js.
  if (pathname.startsWith("/_bridge")) return;
  event.respondWith(proxy(event.request));
});

async function unavailable() {
  const page = await fetch("/index.html", { cache: "no-store" });
  return new Response(page.body, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Ask any open bridge client to relay a fresh port, coalescing concurrent
 * callers onto one attempt so a burst of requests doesn't each ask.
 * @returns {Promise<MessagePort | null>}
 */
function acquirePort() {
  if (bridgePort) return Promise.resolve(bridgePort);
  if (!acquiring) {
    acquiring = (async () => {
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      for (const client of clients) client.postMessage({ type: "bridge:need-port" });
      await new Promise((resolve) => {
        onPort = resolve;
        setTimeout(resolve, 1000);
      });
      onPort = null;
      acquiring = null;
      return bridgePort;
    })();
  }
  return acquiring;
}

async function proxy(request) {
  const port = await acquirePort();
  if (!port) return unavailable();

  const buffer = await request.arrayBuffer();
  const body = buffer.byteLength ? buffer : null;
  const reply = new MessageChannel();
  port.postMessage(
    {
      type: "request",
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body,
      reply: reply.port2,
    },
    body ? [reply.port2, body] : [reply.port2],
  );

  const message = await receive(reply.port1);
  if (!message) {
    // Timed out: the port is presumed dead (its VM page stopped answering
    // mid-connection). Drop it only if it's still the current one — a newer port
    // may have arrived while this older request was timing out.
    if (bridgePort === port) {
      port.close();
      bridgePort = null;
    }
    return unavailable();
  }
  if (message.type === "error") {
    return new Response(`Guest request failed: ${message.message}`, {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(message.body, {
    status: message.status,
    statusText: message.statusText,
    headers: message.headers,
  });
}

/** @param {MessagePort} port */
function receive(port) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15_000);
    port.onmessage = ({ data }) => {
      clearTimeout(timer);
      resolve(data);
    };
  });
}

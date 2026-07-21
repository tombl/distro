importScripts("/_bridge/error-page.js");

/** @type {MessagePort | null} */
let bridgePort = null;
/** @type {string | null} last VM page URL a port arrived with (the fix link) */
let vmUrl = null;
/** @type {Promise<MessagePort | null> | null} shared in-flight port acquisition */
let acquiring = null;
/** @type {(() => void) | null} wakes the current acquisition when a port lands */
let onPort = null;
let served = 0;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", ({ data, ports }) => {
  if (data?.type !== "bridge:port") return;
  bridgePort = ports[0];
  if (data.vmUrl) vmUrl = data.vmUrl;
  onPort?.();
});

self.addEventListener("fetch", (event) => {
  const { pathname } = new URL(event.request.url);
  // The one live path in the namespace: lets the connecting page (and a debugging
  // human) read whether a worker controls the origin, whether a VM page is
  // relaying it, and the current condition code.
  if (pathname === "/_bridge/status") {
    event.respondWith(
      Response.json({
        worker: true,
        connected: bridgePort !== null,
        served,
        code: bridgePort ? null : "BRIDGE_NO_VM",
        vmUrl,
      }),
    );
    return;
  }
  // Everything belongs to the guest site except the bridge's own namespace
  // (/_bridge/* and this script), so hosted content can claim any path — even
  // /sw.js. The error pages come from the shared template imported above.
  if (pathname.startsWith("/_bridge")) return;
  event.respondWith(proxy(event.request));
});

/**
 * @param {"BRIDGE_NO_VM" | "BRIDGE_RELAY_TIMEOUT" | "GUEST_ERROR"} code
 * @param {{ host?: string, message?: string }} [ctx]
 */
function errorResponse(code, ctx = {}) {
  return new Response(self.BridgeErrorPage.renderPage(code, { vmUrl, ...ctx }), {
    status: code === "GUEST_ERROR" ? 502 : 503,
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
  const host = new URL(request.url).host;
  const port = await acquirePort();
  if (!port) return errorResponse("BRIDGE_NO_VM", { host });
  served++;

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
    return errorResponse("BRIDGE_RELAY_TIMEOUT", { host });
  }
  if (message.type === "error") {
    return errorResponse("GUEST_ERROR", { message: message.message, host });
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

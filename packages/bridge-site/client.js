/**
 * Serve a family of guest origins from one VM page, binding each origin lazily
 * the first time a cold navigation demands it. This is the only public entry
 * point; the main-origin app imports it source-form (no build step). See
 * readme.md for the demand/bind/recover flow.
 *
 * The family is derived from `hub`: a guest origin is the hub origin with the
 * "hub" label replaced by a canonical decimal port (1..65535, no leading
 * zeroes). The hub, the guests, and this page must all be same-site, or the
 * browser partitions the rendezvous BroadcastChannel and the guests' service
 * workers away.
 *
 * Exactly one VM tab is the provider: a Web Lock keyed to the hub is held for
 * this handle's lifetime, so later tabs wait on the lock rather than racing to
 * answer the same demand.
 *
 * Call this once the guest can serve. Navigating a guest origin never starts
 * anything — like localhost, a port with no listener answers each request with
 * the handler's connection-refused error. The factory is synchronous by design:
 * binding must be instant, or a slow warm-up races the service worker's dead-VM
 * relay timeout and cold tabs loop through spurious timeout pages.
 *
 * @param {object} options
 * @param {string} options.hub hub origin, e.g. "https://hub.guest.linux.example"
 * @param {(port: number) => (request: Request) => Promise<Response>} options.fetch
 *   per-origin handler factory, given a demanded origin's port.
 * @returns {{ close(): void }}
 */
export function serveGuest({ hub, fetch }) {
  const hubUrl = new URL(hub);
  // Everything after the first host label, e.g. ".guest.linux.example", shared by
  // the hub and every guest origin.
  const suffix = hubUrl.hostname.slice(hubUrl.hostname.indexOf("."));

  /** @type {Map<string, { close(): void }>} full guest origin -> its binding */
  const bindings = new Map();
  let closed = false;
  /** @type {(() => void) | null} resolves to release the provider Web Lock */
  let release = null;
  /** @type {HTMLIFrameElement | null} */
  let provider = null;

  /** @param {string} origin @returns {number | null} guest TCP port, if in-family */
  function portFor(origin) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      return null;
    }
    if (url.protocol !== hubUrl.protocol || url.port !== hubUrl.port) return null;
    const dot = url.hostname.indexOf(".");
    if (dot < 0 || url.hostname.slice(dot) !== suffix) return null;
    const label = url.hostname.slice(0, dot);
    if (!/^[1-9]\d*$/.test(label)) return null;
    const port = Number(label);
    return port <= 65535 ? port : null;
  }

  /** @param {string} origin full guest origin the hub relayed a demand for */
  function bind(origin) {
    const port = portFor(origin);
    // Validate then key the map by full origin; duplicate demands are no-ops, so
    // a lost or repeated broadcast is harmless.
    if (port === null || bindings.has(origin)) return;
    bindings.set(origin, connectBridge({ origin, fetch: fetch(port) }));
  }

  /** @param {MessageEvent} event */
  function onMessage(event) {
    if (event.source !== provider?.contentWindow || event.origin !== hubUrl.origin) return;
    if (event.data?.version !== 1 || event.data.type !== "demand") return;
    bind(event.data.origin);
  }

  navigator.locks.request(`linux-bridge-provider:${hubUrl.origin}`, { mode: "exclusive" }, () => {
    if (closed) return;
    // Hold the lock (and stay the provider) until close() resolves this promise.
    return new Promise((resolve) => {
      release = resolve;
      provider = document.createElement("iframe");
      provider.hidden = true;
      provider.src = `${hubUrl.origin}/_bridge/provider.html`;
      provider.addEventListener("load", () => {
        // Hand the provider our origin so it posts demands only back to us.
        provider?.contentWindow?.postMessage({ version: 1, type: "hello" }, hubUrl.origin);
      });
      window.addEventListener("message", onMessage);
      document.body.appendChild(provider);
    });
  });

  return {
    close() {
      closed = true;
      window.removeEventListener("message", onMessage);
      provider?.remove();
      provider = null;
      for (const binding of bindings.values()) binding.close();
      bindings.clear();
      release?.();
    },
  };
}

/**
 * Bind one full guest origin to one handler: embed a hidden /_bridge/bridge.html
 * iframe of that origin, and on each bridge:ready relay a fresh MessagePort to
 * its service worker. Internal to serveGuest, which creates one of these per
 * demanded origin and keeps it for the tab's lifetime — it is also the durable
 * client that repairs the origin's worker if it restarts.
 *
 * @param {object} options
 * @param {string} options.origin guest origin, e.g. "https://8080.guest.example"
 * @param {(request: Request) => Promise<Response>} options.fetch serves the guest
 * @returns {{ close(): void }}
 */
function connectBridge({ origin, fetch }) {
  const iframe = document.createElement("iframe");
  iframe.hidden = true;
  iframe.src = `${origin}/_bridge/bridge.html`;

  /** @type {MessagePort | null} */
  let port = null;

  /** @param {MessagePort} incoming */
  function serve(incoming) {
    port?.close();
    port = incoming;
    incoming.onmessage = async ({ data }) => {
      const { url, method, headers, body, reply } = data;
      try {
        const response = await fetch(
          new Request(url, { method, headers, body: body ?? undefined }),
        );
        reply.postMessage(
          {
            type: "response",
            status: response.status,
            statusText: response.statusText,
            headers: [...response.headers],
            body: response.body,
          },
          response.body ? [response.body] : [],
        );
      } catch (error) {
        reply.postMessage({ type: "error", message: String(error?.message ?? error) });
      }
    };
  }

  /** @param {MessageEvent} event */
  function onMessage(event) {
    if (event.source !== iframe.contentWindow) return;
    if (event.data?.type !== "bridge:ready") return;
    // A fresh channel per ready covers both startup and service-worker restarts.
    const channel = new MessageChannel();
    serve(channel.port1);
    // vmUrl travels with the port so the worker can offer "Open the VM page" on
    // its error pages — the actual fix when the relay breaks, not just a reload.
    const message = { type: "bridge:port", vmUrl: location.href };
    iframe.contentWindow.postMessage(message, origin, [channel.port2]);
  }

  window.addEventListener("message", onMessage);
  document.body.appendChild(iframe);

  return {
    close() {
      window.removeEventListener("message", onMessage);
      port?.close();
      iframe.remove();
    },
  };
}

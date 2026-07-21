// The worker script sits at the root (not under /_bridge/) because a worker
// can only claim its script's directory as scope without extra headers.
await navigator.serviceWorker.register("/_bridge_sw.js", { scope: "/" });
const registration = await navigator.serviceWorker.ready;

// The VM page (serveGuest) is our only legitimate embedder. Pin its origin from
// the first message it sends and refuse anything else, so a hostile same-site
// page can't replace this worker's port. A frame-ancestors CSP naming the VM
// origin is the production backstop (see public/_headers).
/** @type {string | null} */
let embedder = null;

const announce = () => window.parent.postMessage({ type: "bridge:ready" }, embedder ?? "*");

navigator.serviceWorker.addEventListener("message", ({ data }) => {
  if (data?.type === "bridge:need-port") announce();
});

window.addEventListener("message", ({ data, source, origin, ports }) => {
  if (source !== window.parent) return;
  if (embedder === null) embedder = origin;
  else if (origin !== embedder) return;
  if (data?.type !== "bridge:port") return;
  // Relay the port and the VM page's own URL (for the worker's error pages).
  registration.active.postMessage({ type: "bridge:port", vmUrl: data.vmUrl }, ports);
});

announce();

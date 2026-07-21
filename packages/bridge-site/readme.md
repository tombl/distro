# Bridge site

Serves an HTTP site running inside a Linux-in-wasm guest (a page on the
cross-origin-isolated main site) at a separate bridge origin, so a browser can
navigate to it as an ordinary URL.

The main page calls `serveGuest({ hub, fetch })` (`./client`) once. `hub` is a
fixed origin (e.g. `https://hub.guest.linux.example`); the guest family is the
hub origin with the `hub` label swapped for a canonical decimal port, so
`https://8080.guest.linux.example` is guest port 8080. Nothing is pre-declared:
origins bind lazily, on demand.

A cold navigation to a guest origin lands on the static `index.html`, which
registers `/_bridge_sw.js` at scope `/` (the script sits at the root because a
worker cannot claim above its own directory; everything else is namespaced so
hosted sites keep every path outside `/_bridge`) and shows the connecting page.
That page embeds a short-lived requester iframe of `hub/_bridge/requester.html`,
which broadcasts an idempotent "this origin is wanted" demand on a same-site
`BroadcastChannel`. The VM page holds an exclusive Web Lock (one provider tab)
and embeds `hub/_bridge/provider.html`, which relays each demand up. `serveGuest`
validates the demanded origin against the family, derives its port, and — the
existing mechanism — embeds a hidden `/_bridge/bridge.html` iframe of that
origin. The iframe relays a fresh `MessagePort` (with the VM page's own URL,
`vmUrl`) to the origin's service worker on each `bridge:ready`. The worker then
intercepts navigations to that origin, forwards each over the port to the bound
`fetch(port)` handler, and answers with the guest's response; the connecting
page polls `/_bridge/status` and reloads once the relay is live. Each bind
persists for the VM tab's lifetime, so its iframe also repairs the origin's
worker if it restarts. Port-number parsing lives in exactly two places: the
fallback page validating its own hostname, and `serveGuest` validating a
demanded origin.

When a link in that chain is broken, the worker (or, before it installs, the
static `index.html`) serves a Chromium-style status page from the shared,
data-driven template in `public/_bridge/error-page.js`: `BRIDGE_BAD_PORT` (the
origin's label isn't a guest port, or is the reserved `hub`), `BRIDGE_CONNECTING`
(the install phase, demanding a VM), `BRIDGE_NO_VM` (worker up, no VM page
relaying), `BRIDGE_RELAY_TIMEOUT` (the VM page stopped answering mid-connection),
and `GUEST_ERROR` (the guest handler threw, 502). The demand conditions embed
the requester and reload once a VM binds the origin, so recovery needs no prior
knowledge. Each renders its condition code — also exposed on `/_bridge/status` —
so tests and humans assert on codes, not prose.

## Local testing

No deploy needed: `*.bridge.localhost` resolves to 127.0.0.1 natively in
Chrome and Firefox (not Safari).

```
bash scripts/prepare-assets.sh   # once, or whenever guest assets change
node server.js
```

Then open <http://main.bridge.localhost:4181/vm.html> and, in another tab,
navigate to any `<port>.bridge.localhost:4180`. The VM page boots a real guest
serving busybox httpd on 8080 the first time an origin is demanded, so
`http://8080.bridge.localhost:4180/` reaches it (boot log on the VM page). Other
ports bind too, but nothing listens on them inside the guest.
`http://main.bridge.localhost:4181/` is the same wiring with a stub echo handler
instead of a guest, keyed on the demanded port. `pnpm test` runs the whole flow
headlessly.

The VM page, the hub, and the guest origins must all be **same-site** — that is
why the recipe uses `main.bridge.localhost`, not `127.0.0.1`: browsers partition
a cross-site iframe's service-worker registration *and* its `BroadcastChannel`,
so a partitioned worker never intercepts top-level navigations and a partitioned
rendezvous never reaches the VM page. The same constraint holds in production (an
app on `linux.example` can serve `*.guest.linux.example`, but not a separate
domain). When something doesn't work, `GET /_bridge/status` on a guest origin —
or just the connecting page itself — says whether a worker controls the origin
and whether a VM page is relaying it.

## TODO(tom)

- Create the Cloudflare Pages project (placeholder `linux-bridge` in
  `.github/workflows/ci.yml`).
- Configure wildcard DNS / custom domain for the subdomain family (e.g.
  `*.guest.linux.tombl.dev`, with `hub.guest.linux.tombl.dev` as the rendezvous
  hub). Must be same-site with the app that calls `serveGuest` (see above) — a
  separate registrable domain will not work.
- Settle the production hub origin the main app passes to `serveGuest`
  (e.g. `https://hub.guest.linux.tombl.dev`) and fill in the `frame-ancestors`
  CSP for the VM origin in `public/_headers`.

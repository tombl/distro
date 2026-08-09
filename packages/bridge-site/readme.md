# Bridge site

Serves an HTTP site running inside a Linux-in-wasm guest (a page on the
cross-origin-isolated main site) at a separate bridge origin, so a browser can
navigate to it as an ordinary URL.

The main page calls `serveGuest({ hub, fetch })` (`./client`) once. `hub` is a
fixed origin (`https://hub.localhost.low.land` in production); the guest family is the
hub origin with the `hub` label swapped for a canonical decimal port, so
`https://8080.localhost.low.land` is guest port 8080. Nothing is pre-declared:
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
origin. The iframe relays a fresh `MessagePort` to the origin's service worker
on each `bridge:ready`. The worker then
intercepts navigations to that origin, forwards each over the port to the bound
`fetch(port)` handler, and answers with the guest's response; the connecting
page polls `/_bridge/status` and reloads once the relay is live. Each bind
persists for the VM tab's lifetime, so its iframe also repairs the origin's
worker if it restarts. Port-number parsing lives in exactly two places: the
fallback page validating its own hostname, and `serveGuest` validating a
demanded origin.

`index.html` is also the unavailable page. It installs the worker, demands a VM,
and reloads when `/_bridge/status` reports a live relay. A guest handler failure
is returned as a plain-text 502. This deliberately keeps the bridge focused on
transport instead of maintaining a second error-page application.

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
rendezvous never reaches the VM page. The same constraint holds in production:
the VM at `low.land` and `*.localhost.low.land` share the `low.land` site. A
separate registrable domain would not work. `GET /_bridge/status` on a guest
origin reports whether a VM page is currently relaying it.

## Building and hosting

`nix build .#bridge-site` produces a provider-neutral static site. Serve the
result at both `hub.localhost.low.land` and `*.localhost.low.land`. The host must:

- terminate TLS for the wildcard family;
- serve files from the derivation at every hostname in that family;
- fall back to `index.html` for paths which are not real files; and
- add these headers to `/_bridge/bridge.html`, `/_bridge/bridge.js`,
  `/_bridge/provider.html`, and `/_bridge/requester.html`:

  ```text
  Cross-Origin-Resource-Policy: cross-origin
  Cross-Origin-Embedder-Policy: require-corp
  ```

- restrict `/_bridge/bridge.html` and `/_bridge/provider.html` to the VM page:

  ```text
  Content-Security-Policy: frame-ancestors https://low.land
  ```

- restrict `/_bridge/requester.html` to the numbered guest origins which embed
  it (a `low.land`-only rule here would break cold navigation):

  ```text
  Content-Security-Policy: frame-ancestors https://*.localhost.low.land
  ```

`index.html` and `/_bridge_sw.js` should be served with `Cache-Control: no-cache`
so bridge rollouts and service-worker update checks do not retain old protocol
code. JavaScript responses must use a JavaScript MIME type.

The VM page must remain same-site with the bridge family. Copy or bundle
`packages/bridge-site/client.js` into that page and call `serveGuest` once its
guest network is ready:

```js
import { guestFetchHandler } from "@tombl/linux-guest";
import { serveGuest } from "./bridge-client.js";

serveGuest({
  hub: "https://hub.localhost.low.land",
  fetch: (port) => guestFetchHandler(guest.network, { port }),
});
```

Hosting, DNS, certificate provisioning, and header configuration deliberately
remain outside this repository.

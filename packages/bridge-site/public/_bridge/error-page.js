// Chromium-style status pages for the bridge, data-driven: one entry per
// condition, one template. This is the single source for that copy — loaded two
// ways, so no ES module syntax (everything hangs off self.BridgeErrorPage):
//   - importScripts()'d into the classic service worker, which builds full HTML
//     responses for the navigation it is answering, and
//   - a <script> tag in index.html, which renders the fallback client-side.
//
// Condition codes are load-bearing: rendered on the page (small grey monospace,
// like Chromium's ERR_*), exposed in /_bridge/status, and asserted on by tests.
// Each condition: title, description(ctx), fixes(ctx) -> string[], the optional
// primary button label, and flags. ctx carries { vmUrl, host, message } as
// available. The demand conditions embed the rendezvous requester and reload
// once a VM page binds this origin (see DEMAND_SCRIPT).
(() => {
  /** @param {string | undefined} host @returns {string | null} guest port */
  function guestPort(host) {
    const label = host?.split(".")[0];
    return label && /^[1-9]\d*$/.test(label) ? label : null;
  }

  const CONDITIONS = {
    // The one terminal condition: this origin's label isn't a guest port (or is
    // the reserved "hub"), so nothing here maps to a guest server.
    BRIDGE_BAD_PORT: {
      title: "Not a guest port",
      description: () =>
        "This origin's first label isn't a port number, so it names no guest " +
        "server. Guest origins look like <port>.<family> — for example 8080 on " +
        "this family.",
      fixes: () => [],
      button: null,
    },
    // Install phase / recovery: keep demanding a VM page and reload when one
    // answers. Starts minimal, then reveals guidance after ~10s (escalate).
    BRIDGE_CONNECTING: {
      title: "Waiting for a VM page…",
      description: () =>
        "This origin is installing. It needs a VM page open and same-site to " +
        "serve it. This page keeps asking and loads automatically once one answers.",
      fixes: () => [
        "Open the VM page for this origin and keep its tab open.",
        "Make sure it's same-site with this origin, or the browser partitions it away.",
      ],
      button: null,
      demand: true,
      escalate: true,
    },
    BRIDGE_NO_VM: {
      title: "No VM page is connected",
      description: () =>
        "The service worker is installed, but no VM page is relaying this origin " +
        "right now. This page keeps asking and loads automatically once one answers.",
      fixes: () => [
        "Open the VM page for this origin and keep its tab open.",
        "Make sure it's same-site with this origin, or the browser partitions it away.",
      ],
      button: null,
      demand: true,
    },
    BRIDGE_RELAY_TIMEOUT: {
      title: "The VM page stopped responding",
      description: () =>
        "The VM page stopped answering mid-connection, so this request timed out. " +
        "This page keeps asking and loads automatically once a VM answers again.",
      fixes: () => [
        "Reopen or reload the VM page for this origin.",
        "Check the VM page's console. Its guest may have crashed or hung.",
      ],
      button: null,
      demand: true,
      vmLink: true,
    },
    GUEST_ERROR: {
      title: "The guest server errored",
      description: (ctx) =>
        "The VM page is connected, but serving this request failed inside the " +
        `guest: ${ctx.message || "the guest handler threw."}`,
      fixes: (ctx) => {
        const port = guestPort(ctx.host);
        return [
          port
            ? `Start a server on 0.0.0.0:${port} inside the guest.`
            : "Start a server inside the guest on the port this origin maps to.",
          "Check the VM page's console for the guest's error.",
        ];
      },
      button: "Retry",
      vmLink: true,
    },
  };

  /** @param {unknown} value */
  const esc = (value) =>
    String(value).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );

  const STYLE = `
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main {
      font: 1rem/1.6 system-ui, sans-serif;
      max-width: 30rem;
      margin: 15vh auto;
      padding: 0 1.5rem;
      color: #202124;
    }
    h1 { font-size: 1.5rem; font-weight: 500; margin: 0 0 1rem; }
    p { color: #5f6368; margin: 0 0 1rem; }
    .try { color: #202124; margin-bottom: 0.25rem; }
    ul { margin: 0.25rem 0 1.5rem; padding-left: 1.25rem; color: #5f6368; }
    li { margin: 0.25rem 0; }
    .actions { display: flex; gap: 1rem; align-items: center; }
    button {
      font: inherit;
      color: #fff;
      background: #1a73e8;
      border: 0;
      border-radius: 4px;
      padding: 0.5rem 1rem;
      cursor: pointer;
    }
    button:hover { background: #1b66c9; }
    a.secondary { color: #1a73e8; text-decoration: none; }
    a.secondary:hover { text-decoration: underline; }
    .code {
      font-family: ui-monospace, monospace;
      font-size: 0.75rem;
      color: #80868b;
      margin-top: 2rem;
    }
    @media (prefers-color-scheme: dark) {
      main { color: #e8eaed; }
      h1, .try { color: #e8eaed; }
      p, ul, .code { color: #9aa0a6; }
      button { background: #8ab4f8; color: #202124; }
      a.secondary { color: #8ab4f8; }
    }`;

  const DEMAND_SCRIPT = `<script>
  // Summon a VM page: embed the rendezvous hub's requester, which broadcasts a
  // demand for this origin until a VM binds it. Then poll the worker and reload
  // to real content once a relay is live. The hub is this origin with its port
  // label replaced by the reserved "hub" label.
  (() => {
    const url = new URL(location.href);
    const suffix = url.hostname.slice(url.hostname.indexOf("."));
    const hub = url.protocol + "//hub" + suffix + (url.port ? ":" + url.port : "");
    const iframe = document.createElement("iframe");
    iframe.hidden = true;
    iframe.src = hub + "/_bridge/requester.html";
    iframe.addEventListener("load", () => {
      // The requester reads the demanded origin from this message's origin.
      iframe.contentWindow.postMessage({ version: 1, type: "demand" }, hub);
    });
    document.body.appendChild(iframe);
    setInterval(async () => {
      try {
        const status = await fetch("/_bridge/status", { cache: "no-store" }).then((r) => r.json());
        if (status.connected) location.reload();
      } catch {}
    }, 1000);
  })();
<\/script>`;

  const ESCALATE_SCRIPT = `<script>
  // Start minimal; after ~10s of unanswered demands, reveal the "open a VM page"
  // guidance without disturbing the demand loop above.
  setTimeout(() => {
    const guidance = document.getElementById("bridge-guidance");
    if (guidance) guidance.hidden = false;
  }, 10000);
<\/script>`;

  /**
   * Full HTML document for a condition. The service worker returns it as a
   * Response; index.html document.write()s it. vmUrl, when known, adds the "Open
   * the VM page" action (a new tab, so this waiting tab hears the provider and
   * finishes on its own). Demand conditions embed the rendezvous requester.
   *
   * @param {keyof CONDITIONS} code
   * @param {{ vmUrl?: string | null, host?: string, message?: string }} [ctx]
   */
  function renderPage(code, ctx = {}) {
    const c = CONDITIONS[code];
    const fixes = c.fixes(ctx);
    const vmLink =
      c.vmLink && ctx.vmUrl
        ? `<a class="secondary" target="_blank" rel="noopener" href="${esc(ctx.vmUrl)}">Open the VM page</a>`
        : "";
    const tryList = fixes.length
      ? `<p class="try">Try:</p>\n  <ul>${fixes.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`
      : "";
    const actions =
      c.button || vmLink
        ? `<p class="actions">${c.button ? `<button onclick="location.reload()">${esc(c.button)}</button>` : ""}${vmLink}</p>`
        : "";
    const guidance = `${tryList}\n  ${actions}`.trim();
    // The connecting page holds guidance back while the first demands fly.
    const guidanceBlock =
      guidance && c.escalate
        ? `<div id="bridge-guidance" hidden>\n  ${guidance}\n  </div>`
        : guidance;
    return `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(c.title)}</title>
<style>${STYLE}
</style>
<main>
  <h1>${esc(c.title)}</h1>
  <p>${esc(c.description(ctx))}</p>
  ${guidanceBlock}
  <p class="code" id="bridge-error-code">${esc(code)}</p>
</main>
${c.demand ? DEMAND_SCRIPT : ""}
${c.escalate ? ESCALATE_SCRIPT : ""}
`;
  }

  self.BridgeErrorPage = { renderPage };
})();

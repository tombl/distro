// @ts-check
// The page always has these elements.
const status = /** @type {HTMLElement} */ (document.querySelector("#status"));
const detail = /** @type {HTMLElement} */ (document.querySelector("#detail"));
const code = /** @type {HTMLElement} */ (document.querySelector("#bridge-code"));
const label = location.hostname.split(".")[0] ?? "";
const valid = /^[1-9]\d*$/.test(label) && Number(label) <= 65535;

if (!valid) {
  status.textContent = "Not a guest port";
  detail.textContent = "The first hostname label must be a port number from 1 to 65535.";
  code.textContent = "BRIDGE_BAD_PORT";
} else {
  connect().catch((error) => {
    status.textContent = "Could not connect to the guest";
    detail.textContent = String(error?.message ?? error);
    code.textContent = "BRIDGE_ERROR";
  });
}

async function connect() {
  const url = new URL(location.href);
  const suffix = url.hostname.slice(url.hostname.indexOf("."));
  const hub = `${url.protocol}//hub${suffix}${url.port ? `:${url.port}` : ""}`;
  const requester = document.createElement("iframe");
  requester.hidden = true;
  requester.src = `${hub}/_bridge/requester.html`;
  requester.addEventListener("load", () => {
    requester.contentWindow?.postMessage({ version: 1, type: "demand" }, hub);
  });
  document.body.appendChild(requester);

  await navigator.serviceWorker.register("/_bridge_sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) =>
      navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }),
    );
  }

  setInterval(async () => {
    try {
      const response = await fetch("/_bridge/status", { cache: "no-store" });
      if ((await response.json()).connected) location.reload();
    } catch {}
  }, 1000);
}

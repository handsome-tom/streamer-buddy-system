// Loaded first (index.html) when the dock is one of the two panels inside the public demo
// (demo/index.html, with ?sandbox). It keeps the panel to itself:
//
//   - Storage of its own, in memory only. The demo is on the same site as the real dock, so
//     it must never read or change a real mod's or streamer's saved sign-in or settings;
//     a reload of the demo starts fresh.
//   - The relay and Twitch are pretend ones running in the demo page (demo/hub.js): any
//     connection or request for them goes there, never over the internet. The real relay
//     is refused outright, just in case.
(() => {
  let host = null;
  try {
    host = window.parent !== window && window.parent.SANDBOX; // another site's page can't be read: no sandbox
  } catch {}
  if (!host) return; // not inside the demo: nothing to do (and no sandbox, so dock.js stays normal)
  const params = new URLSearchParams(location.search);

  // ----- Storage: a Map with localStorage's methods, seeded with what the demo needs -----
  const data = new Map(Object.entries(host.seed(params.get("dev") || "")));
  const storage = {
    getItem: (k) => (data.has(String(k)) ? data.get(String(k)) : null),
    setItem: (k, v) => void data.set(String(k), String(v)),
    removeItem: (k) => void data.delete(String(k)),
    clear: () => data.clear(),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, get: () => storage });
  Object.defineProperty(window, "sessionStorage", { configurable: true, get: () => storage });

  // ----- The pretend relay and Twitch ----------------------------------------------------
  window.SANDBOX_RELAY = "wss://sandbox.invalid/ws";
  const pretend = (url) => {
    try {
      const u = new URL(url, location.href);
      return u.hostname === "sandbox.invalid" || u.pathname.includes("/mock/") || u.hostname.endsWith("workers.dev");
    } catch {
      return false;
    }
  };
  const NativeSocket = window.WebSocket;
  function SandboxedSocket(url, protocols) {
    if (pretend(url)) return new host.Socket(String(url));
    return new NativeSocket(url, protocols);
  }
  Object.assign(SandboxedSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  SandboxedSocket.prototype = NativeSocket.prototype;
  window.WebSocket = SandboxedSocket;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url;
    if (url && pretend(url)) return host.fetch(url, init);
    return nativeFetch(input, init);
  };
})();

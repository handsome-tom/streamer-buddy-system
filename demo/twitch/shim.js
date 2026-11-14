// The pretend Twitch chat's stand-ins, so StreamSpace's real chat scripts (ext/, copied from
// the extension by dev/sync-extension.sh) run here as they do on twitch.tv, for mod1:
//
//   - chrome.storage and chrome.runtime, as the extension has them. The "hub" port does what
//     the extension's background page does: it talks to the relay as mod1 and passes flags,
//     notes and what comes back both ways. The relay is the demo's pretend one (demo/hub.js,
//     in the page around this one), so a flag here glows in the streamer's dock.
//   - twitch.tv's address and "login" cookie: this is the streamer's channel, and you're the
//     mod (BlazeMod420, the name the demo shows for mod1).
//   - The internet: Twitch's website API and the relay's public lookups answer from the
//     pretend Twitch; nothing here leaves the page.
//
// Loaded first, before the extension's scripts.
(() => {
  const EXT = new URL("ext/", location.href).href;
  const ORIGIN = location.origin;
  const sandbox = () => window.parent !== window && window.parent.SANDBOX;
  window.TWITCH_ME = { login: "mod1", shown: "BlazeMod420", channel: "streamer" };
  // What the demo shows instead of its test logins (play.html's NAMES).
  window.TWITCH_SHOWN = { streamer: "RomansEmpire.TV", mod1: "BlazeMod420", mod2: "DrCoolMod67" };
  const loginOf = (name) => {
    const n = String(name || "").toLowerCase();
    return Object.keys(window.TWITCH_SHOWN).find((l) => window.TWITCH_SHOWN[l].toLowerCase() === n) || n;
  };

  // ----- twitch.tv -----------------------------------------------------------------------------
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => `login=${window.TWITCH_ME.shown.toLowerCase()}; name=${window.TWITCH_ME.shown}`,
    set: () => {},
  });
  // This page's own files keep loading from here (a <base> is fixed when it's added)...
  const base = document.createElement("base");
  base.href = location.href;
  document.head.prepend(base);
  // ...while the address reads like twitch.tv/<channel>, which is how the scripts know whose chat it is.
  history.replaceState(history.state, "", `/${window.TWITCH_ME.channel}`);

  // ----- chrome.storage ---------------------------------------------------------------------------
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const stores = {
    local: new Map(Object.entries({ hubToken: `dev:${window.TWITCH_ME.login}`, featuresOff: [], myChatColor: "#3fc98e" })),
    sync: new Map(),
  };
  const changeListeners = [];
  const later = (fn) => setTimeout(fn, 0);
  const area = (name) => ({
    get(keys, cb) {
      const m = stores[name];
      let out = {};
      if (keys == null) out = Object.fromEntries([...m].map(([k, v]) => [k, clone(v)]));
      else if (typeof keys === "string") m.has(keys) && (out[keys] = clone(m.get(keys)));
      else if (Array.isArray(keys)) for (const k of keys) m.has(k) && (out[k] = clone(m.get(k)));
      else for (const [k, d] of Object.entries(keys)) out[k] = m.has(k) ? clone(m.get(k)) : d;
      if (cb) later(() => cb(out));
      return Promise.resolve(out);
    },
    set(items, cb) {
      const changes = {};
      for (const [k, v] of Object.entries(items || {})) {
        changes[k] = { oldValue: clone(stores[name].get(k)), newValue: clone(v) };
        stores[name].set(k, clone(v));
      }
      later(() => {
        changeListeners.forEach((f) => f(changes, name));
        cb?.();
      });
      return Promise.resolve();
    },
    remove(keys, cb) {
      const changes = {};
      for (const k of [].concat(keys)) {
        if (!stores[name].has(k)) continue;
        changes[k] = { oldValue: clone(stores[name].get(k)) };
        stores[name].delete(k);
      }
      later(() => {
        if (Object.keys(changes).length) changeListeners.forEach((f) => f(changes, name));
        cb?.();
      });
      return Promise.resolve();
    },
  });

  // ----- The background page's relay bridge (the "hub" port) -------------------------------------
  const ports = new Set(); // each: (message) => void
  let socket = null;
  let ready = false;
  let people = null;
  const waiting = [];
  const toPorts = (m) => ports.forEach((tell) => tell(m));
  const tellPeople = () => toPorts({ t: "people", me: people?.me || null, mutual: people?.mutual || [] });
  async function relay() {
    if (socket) return;
    let box = sandbox();
    while (!box) {
      await new Promise((r) => setTimeout(r, 100));
      box = sandbox();
    }
    const ws = new box.Socket("wss://sandbox.invalid/ws");
    socket = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: "auth", token: `dev:${window.TWITCH_ME.login}` }));
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      const m = JSON.parse(e.data);
      if (m.t === "state") {
        people = { me: m.me, mutual: (m.connections || []).filter((c) => c.mutual).map((c) => c.login) };
        tellPeople();
        if (!ready) {
          ready = true;
          for (const w of waiting.splice(0)) ws.send(JSON.stringify(w));
        }
      }
      if (["flash", "unflash", "flashed", "error", "note", "notes", "unnote"].includes(m.t)) toPorts(m);
    };
    ws.onclose = () => {
      socket = null;
      ready = false;
      setTimeout(relay, 2000);
    };
  }
  function fromPage(m) {
    if (m.t === "unflag") return ready && socket.send(JSON.stringify({ t: "unflash", id: m.id }));
    let out = null;
    if (m.t === "note") out = { t: "note", channel: m.channel, chatter: m.chatter, chatterName: m.chatterName, text: m.text, body: m.body, color: m.color, at: m.at };
    else if (m.t === "unnote") out = { t: "unnote", id: m.id, channel: m.channel, at: m.at };
    else if (m.t === "notes") out = { t: "notes", channel: m.channel, from: m.from, to: m.to };
    else if (m.t === "flag") out = { t: "flash", kind: "chat", channel: m.channel, chatter: m.chatter, chatterName: m.chatterName, chatterColor: m.chatterColor, emotes: m.emotes, text: m.text, color: m.color };
    if (!out) return;
    if (ready) socket.send(JSON.stringify(out));
    else {
      waiting.push(out);
      relay();
    }
  }
  function port(name) {
    const onMessage = [];
    const onDisconnect = [];
    const p = {
      name,
      postMessage: (m) => name === "hub" && later(() => fromPage(clone(m))),
      onMessage: { addListener: (f) => onMessage.push(f), removeListener: () => {} },
      onDisconnect: { addListener: (f) => onDisconnect.push(f), removeListener: () => {} },
      disconnect: () => {},
    };
    if (name === "hub") {
      const tell = (m) => later(() => onMessage.forEach((f) => f(clone(m))));
      ports.add(tell);
      if (people) later(() => tell({ t: "people", me: people.me, mutual: people.mutual }));
      relay();
    }
    return p;
  }

  // ----- chrome -----------------------------------------------------------------------------------
  const chrome = {
    runtime: {
      id: "streamspace-playground",
      lastError: undefined,
      getURL: (p) => EXT + String(p).replace(/^\//, ""),
      sendMessage: (msg, cb) => {
        if (cb) later(() => cb(undefined));
        return Promise.resolve(undefined);
      },
      onMessage: { addListener: () => {}, removeListener: () => {} },
      connect: ({ name } = {}) => port(name),
    },
    storage: {
      local: area("local"),
      sync: area("sync"),
      onChanged: { addListener: (f) => changeListeners.push(f), removeListener: () => {} },
    },
  };
  Object.defineProperty(window, "chrome", { configurable: true, get: () => chrome });

  // ----- The internet: answered by the pretend Twitch ------------------------------------------------
  const realFetch = window.fetch.bind(window);
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  async function pretendUser(name) {
    const login = loginOf(name);
    const box = sandbox();
    let u = null;
    try {
      u = box ? (await (await box.fetch(`${ORIGIN}/mock/helix/users?id=u-${encodeURIComponent(login)}`)).json()).data?.[0] : null;
    } catch {}
    return {
      login: String(name || "").toLowerCase(),
      displayName: window.TWITCH_SHOWN[login] || u?.display_name || name,
      chatColor: window.TWITCH_COLORS?.[login] || (login === window.TWITCH_ME.login ? "#3fc98e" : "#a970ff"),
      profileImageURL: u?.profile_image_url || null,
    };
  }
  window.fetch = async (input, init) => {
    const url = String(input?.url || input);
    if (url.startsWith("https://gql.twitch.tv/")) {
      let vars = {};
      try {
        vars = JSON.parse(init?.body || "{}").variables || {};
      } catch {}
      return json({ data: { user: await pretendUser(vars.l || vars.login) } });
    }
    if (/workers\.dev\/api\//.test(url)) {
      const u = new URL(url);
      if (u.pathname.endsWith("/chatcolor")) return json({ color: (await pretendUser(u.searchParams.get("login"))).chatColor });
      if (u.pathname.endsWith("/video")) return json({ data: null });
      return json([]);
    }
    if (url.startsWith(ORIGIN) || url.startsWith(EXT) || url.startsWith("/") || url.startsWith("data:")) return realFetch(input, init);
    return json({}); // nothing leaves the page
  };
})();

// Streamer Buddy System: the hub where a streamer and the people around her
// (mods, regulars) ask each other quick questions. The same page runs as:
//   - the streamer's OBS dock (Docks → Custom Browser Docks), and its pop-out
//     windows (?popout)
//   - the hub in Twitch Space's Chrome side panel (?embed=ext, inside an
//     iframe: sign-in is handed over by the extension, see below)
// Everyone talks through the relay (relay/ in this repo, on Cloudflare): a
// WebSocket that signs in with your Twitch sign-in, keeps connections and the
// week's questions, and says who's online. Questions wait there for anyone
// who's offline.
//
// What's on screen:
//   - the top bar: one profile-picture dot per connection, ringed green while
//     they're online, faded until they've added you back. Something waiting
//     from someone makes their dot pulse in their Twitch chat colour with a
//     count. Clicking a waiting dot shows the cards (popped out into a window
//     of their own in OBS, which closes itself once nothing's waiting);
//     clicking a quiet dot opens their page: an Ask box for them and the log of
//     everything between you (questions both ways, answers, seen or not), each
//     clearable, or all.
//   - the newest question (or answer to yours, or connection request) right in
//     the bar with its buttons, so an OBS dock kept one row tall works on its
//     own; a bar that short opens Ask and Connections as pop-outs too
//   - the bar's quick strip: fast notes from the Ask box's "Quick info" (2
//     minutes), lines of Twitch chat a mod flagged (2 minutes) and "Love notes"
//     (30 seconds, fading in and out fuzzily); nothing's stored, so only people
//     online get them
//   - Stats: for each connection, what's public from Twitch (live, viewers,
//     followers, chat mode, next stream, latest clip) plus, if they share, what
//     their own OBS panel records: subs, gifts, bits, follows, raids, ad timing,
//     hype trains and viewer averages and highs (from the day it's switched on)
//   - cards below the bar when there's room: questions to you with six
//     one-tap answers or your own reply; answers to yours with "Mark as seen"
//     (the person who answered sees "✓ Seen"); nothing clears by itself
//
// Connections: two people can ask each other once both have added each other;
// someone who added you shows as a request you can add back.
//
// Updates: index.html loads these files under version.txt; while open it
// checks version.txt every minute and reloads itself when it changes (not
// while you're typing).
//
// Saved in this page's localStorage (OBS keeps it between restarts; inside the
// side panel's iframe it's the iframe's own):
//   "token"    the Twitch sign-in
//   "ui"       { question id: { closed, waitClosed, cleared, gone } }  what you've
//              closed or cleared here (per device; the relay keeps the rest)
//   "ids", "pics", "colors"  Twitch user ids, profile pictures, chat colours
//   "sound"    true to chime when something arrives
//
// Open with ?demo to try it without signing in. On this Mac, ?dev=<name> signs
// in as anyone against the local test relay.

(() => {
  const SCOPES = ""; // signing in only says who you are
  // What sharing stream stats needs from Twitch (a streamer grants it once).
  const STATS_SCOPES = ["channel:read:subscriptions", "bits:read", "channel:read:ads", "channel:read:hype_train", "moderator:read:followers"];
  const SAMPLE_MS = 60 * 1000;
  const HELIX = "https://api.twitch.tv/helix";
  const MAX_LEN = 200;
  const UPDATE_CHECK_MS = 60 * 1000;
  const params = new URLSearchParams(location.search);
  const DEMO = params.has("demo");
  const DEV = location.hostname === "localhost" ? params.get("dev") : null;
  // The popped-out window (OBS): its own connection to the relay, same saved data.
  const POPOUT = params.has("popout");
  // Inside Twitch Space's side panel: sign-in comes from the extension.
  const EMBED = params.get("embed") === "ext";

  const svg = (paths, size = 18) => `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true">${paths}</svg>`;
  const LINE = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';
  const ANSWERS = {
    y: { label: "Yes", icon: `<path d="M4 10.5l4 4 8-9" ${LINE} stroke-width="2.4"/>` },
    n: { label: "No", icon: `<path d="M5 5l10 10M15 5L5 15" ${LINE} stroke-width="2.4"/>` },
    m: { label: "Maybe", icon: `<path d="M7 7.2a3 3 0 1 1 4.2 2.8c-.8.4-1.2 1-1.2 1.8v.7" ${LINE} stroke-width="2.2"/><circle cx="10" cy="15.6" r="1.3" fill="currentColor"/>` },
    s: { label: "Soon", icon: `<path d="M5 2.5h10M5 17.5h10M6 2.5c0 4 8 4.5 8 7.5s-8 3.5-8 7.5M14 2.5c0 4-8 4.5-8 7.5s8 3.5 8 7.5" ${LINE} stroke-width="1.8"/>` },
    o: { label: "OK", icon: '<path d="M7 9l3-6c1.2 0 2 .8 2 2v3h3.5a1.5 1.5 0 0 1 1.5 1.8l-1.1 6A1.5 1.5 0 0 1 14.4 17H7zM3 9h3v8H3z" fill="currentColor"/>' },
    t: { label: "Thank you", icon: '<path d="M10 17s-6.5-4-6.5-8.6A3.6 3.6 0 0 1 10 6.2a3.6 3.6 0 0 1 6.5 2.2C16.5 13 10 17 10 17z" fill="currentColor"/>' },
    c: { label: "Replied", icon: `<path d="M3 4h14v9H8l-4 3v-3H3z" ${LINE} stroke-width="1.8"/>` }, // a typed reply
    x: { label: "", icon: `<path d="M3 10.6V4a1 1 0 0 1 1-1h6.6l6.7 6.7a1 1 0 0 1 0 1.4l-5.6 5.6a1 1 0 0 1-1.4 0z" ${LINE} stroke-width="1.7"/><circle cx="7" cy="7" r="1.3" fill="currentColor"/>` }, // one of the asker's own options
  };
  const STANDARD = ["y", "n", "m", "s", "o", "t"];
  const TAG_ICON = `<svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 10.6V4a1 1 0 0 1 1-1h6.6l6.7 6.7a1 1 0 0 1 0 1.4l-5.6 5.6a1 1 0 0 1-1.4 0z"/><circle cx="7" cy="7" r="1.2" fill="currentColor"/></svg>`;
  const PEOPLE_ICON = `<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="7.5" cy="6.5" r="3"/><path d="M2 17c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><circle cx="14" cy="7.5" r="2.4"/><path d="M14.5 12.2c2.2.3 3.8 2 3.8 4.3"/></svg>`;
  // Accounts whose picture gets a bright ring everywhere, so they stand out
  // (Alex's own channel).
  const HIGHLIGHT = { myspacetomofficial: "#3fb2ff" };
  const MAX_OPTIONS = 8;

  // A question's answer buttons, in the asker's order: { code, label }. The
  // asker's own options are code "x" with their label.
  const optionsOf = (q) => (q.options || STANDARD).map((o) => (o.startsWith("+") ? { code: "x", label: o.slice(1) } : { code: o, label: ANSWERS[o].label }));
  // What an answer says: a typed reply or own option's words, else its label.
  const said = (a) => (a.code === "c" || a.code === "x" ? a.text : ANSWERS[a.code].label);

  const main = document.getElementById("main");
  const statusEl = document.getElementById("status");
  const dotsEl = document.getElementById("dots");
  const peekEl = document.getElementById("peek");
  const askBtn = document.getElementById("askBtn");
  const peopleBtn = document.getElementById("peopleBtn");
  const quickAsk = document.getElementById("quickAsk");
  const quickEl = document.getElementById("quick");
  const flashesEl = document.getElementById("flashes");
  const quickTo = document.getElementById("quickTo");
  const quickText = document.getElementById("quickText");
  const askFull = document.getElementById("askFull");
  const statsBtn = document.getElementById("statsBtn");
  const chatBtn = document.getElementById("chatBtn");
  const chatCount = document.getElementById("chatCount");

  let me = null; // { login, id }
  let view = POPOUT && /^(ask|people|person|chat|stats)$/.test(params.get("view")) ? params.get("view") : "cards"; // "cards" | "ask" | "people" | "person"
  const drafts = {}; // question id -> reply being typed (kept if things redraw)
  // The Ask box: who to, the question, and its answer buttons (the six
  // standard ones until some are taken off; "+label" for your own).
  const askDraft = { to: (POPOUT && params.get("to")) || "", text: "", note: "", options: [...STANDARD], adding: "", mode: "ask" }; // mode: "ask" | "info" | "love"

  // ===== Saved data ========================================================================

  function get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  }
  function put(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  // From the relay.
  let connections = []; // [{ login, mutual, online }]
  let requests = []; // [login] who added you
  let tags = {}; // { tag: [logins] } your own groups of connections (Mods, Lead mods, Tech…)
  // Mod chat: the rooms you're in ({ owner, tag, members: [{ login, online }] })
  // and each room's recent messages ({ owner: [{ id, from, text, at }] }).
  let rooms = [];
  let chat = {};
  // Stats: what the relay has ({ login: worked-out stats }), whether you share
  // yours, and what Twitch says publicly ({ login: { ..., at } }).
  let stats = {};
  let statsOn = false;
  const publicStats = {};
  const statsDraft = { who: (POPOUT && params.get("view") === "stats" && params.get("to")) || "" };
  const chatDraft = { owner: (POPOUT && params.get("view") === "chat" && params.get("to")) || "", text: "" };
  const questions = {}; // id -> { id, from, to, text, at, answer, dismissed, seenAt }
  const pending = {}; // id -> true while an answer / seen / dismiss is on its way
  let ready = false; // first state from the relay arrived

  const ui = get("ui", {});
  const ids = get("ids", {});
  const pics = get("pics", {});
  const colors = get("colors", {});

  function setUi(id, change) {
    ui[id] = { ...ui[id], ...change };
    for (const k of Object.keys(ui)) if (!questions[k] && ready) delete ui[k]; // the relay forgot it (a week old)
    put("ui", ui);
    render();
  }

  // The questions, as the drawing code wants them: questions to you (inbox)
  // and questions you asked (sent), with what you've closed here.
  let inbox = {};
  let sent = {};
  function derive() {
    inbox = {};
    sent = {};
    for (const q of Object.values(questions)) {
      const u = ui[q.id] || {};
      if (q.to === me?.login) {
        inbox[q.id] = {
          from: q.from, name: q.from, text: q.text, at: q.at, options: q.options, group: q.group, toTag: q.toTag,
          done: !!(q.answer || q.dismissed), answered: q.answer, seenAt: q.seenAt,
          sending: !!pending[q.id], cleared: !!u.cleared, gone: !!u.gone,
        };
      } else if (q.from === me?.login) {
        sent[q.id] = {
          to: q.to, text: q.text, at: q.at, group: q.group, toTag: q.toTag, seen: !!u.waitClosed || !!q.dismissed, gone: !!u.gone,
          answer: q.answer && { ...q.answer, acked: q.seenAt ? true : pending[q.id] ? "sending" : false, seen: !!u.closed },
        };
      }
    }
  }

  const trusted = () => connections.map((c) => c.login);
  // Everyone you can ask: "*" for everyone, "#Tag" for one of your tags (with
  // someone askable in it), then each person.
  function targets() {
    const able = connections.filter((c) => c.mutual).map((c) => c.login);
    const tagged = Object.keys(tags).sort().filter((t) => tags[t].some((l) => able.includes(l)));
    return [...(able.length > 1 ? ["*"] : []), ...tagged.map((t) => `#${t}`), ...able];
  }
  function targetLabel(t) {
    const able = connections.filter((c) => c.mutual).map((c) => c.login);
    if (t === "*") return `Everyone (${able.length})`;
    if (t.startsWith("#")) return `${t.slice(1)} (${tags[t.slice(1)].filter((l) => able.includes(l)).length})`;
    return t;
  }
  const askedWho = (q) => (q.toTag === "everyone" || !q.toTag ? "everyone" : q.toTag);
  const conn = (login) => connections.find((c) => c.login === login);

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.title = text;
    statusEl.className = `bar__status${kind ? ` bar__status--${kind}` : ""}`;
  }

  // A text box that password managers leave alone.
  function textBox(placeholder, value = "") {
    const input = el("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.value = value;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.name = "hub-" + placeholder.toLowerCase().replace(/\W+/g, "-");
    input.setAttribute("data-1p-ignore", "");
    input.setAttribute("data-lpignore", "true");
    input.setAttribute("data-bwignore", "");
    input.setAttribute("data-form-type", "other");
    return input;
  }

  // ===== Signing in ========================================================================
  // Twitch's implicit sign-in: off to Twitch, back here with the token after "#".
  // In the side panel, Twitch's sign-in page can't open inside the iframe, so
  // the extension does it in a window of its own and hands the token over.

  function signIn() {
    if (EMBED) return parent.postMessage({ t: "hub-signin" }, "*");
    const state = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    put("signinState", state);
    const q = new URLSearchParams({
      response_type: "token",
      client_id: TWITCH_CLIENT_ID,
      redirect_uri: location.origin + location.pathname,
      scope: get("statsWanted", false) ? STATS_SCOPES.join(" ") : SCOPES,
      state,
    });
    location.href = `https://id.twitch.tv/oauth2/authorize?${q}`;
  }

  // Back from Twitch: keep the token and clear it out of the address.
  function takeTokenFromAddress() {
    if (!location.hash.includes("access_token") && !location.search.includes("error")) return;
    const h = new URLSearchParams(location.hash.slice(1));
    const state = h.get("state") || params.get("state");
    if (state && state === get("signinState") && h.get("access_token")) put("token", h.get("access_token"));
    localStorage.removeItem("signinState");
    history.replaceState(null, "", location.pathname + (EMBED ? "?embed=ext" : ""));
    if (params.get("error")) return params.get("error_description") || params.get("error");
  }

  // The extension (our parent page) handing over a sign-in.
  addEventListener("message", (e) => {
    if (!EMBED || e.source !== parent || !String(e.origin).startsWith("chrome-extension://")) return;
    if (e.data?.t === "hub-token" && typeof e.data.token === "string") {
      put("token", e.data.token);
      start();
    }
  });

  async function validate() {
    const token = get("token");
    if (!token) return null;
    const r = await fetch("https://id.twitch.tv/oauth2/validate", { headers: { Authorization: `OAuth ${token}` } });
    if (r.status === 401) {
      localStorage.removeItem("token");
      return null;
    }
    if (!r.ok) throw new Error(`Twitch said ${r.status}`);
    const j = await r.json();
    return { login: j.login, id: j.user_id, scopes: j.scopes || [], expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : 0 };
  }

  // Twitch sign-ins run out; a few days before, the bar says so (in red once
  // it has), with a button to sign in again.
  const RENEW_MS = 3 * 24 * 60 * 60 * 1000;
  function signinNote() {
    if (!me?.expiresAt || DEMO) return "";
    const left = me.expiresAt - Date.now();
    if (left <= 0) return "Twitch sign-in ran out";
    if (left > RENEW_MS) return "";
    const days = Math.max(1, Math.round(left / 86400000));
    return `Twitch sign-in ends in ${days} day${days === 1 ? "" : "s"}`;
  }
  function signinPill() {
    const b = el("button", `pill pill--warn${me.expiresAt <= Date.now() ? " pill--bad" : ""}`, `${signinNote()} · Renew`);
    b.type = "button";
    b.addEventListener("click", signIn);
    return b;
  }

  // In the side panel: Twitch Space keeps its own copy of the sign-in, for
  // flagging chat lines from Twitch's page. Only ever to our own extension page.
  function shareSignin(token) {
    const origin = location.ancestorOrigins?.[0] || "";
    if (EMBED && origin.startsWith("chrome-extension://")) parent.postMessage({ t: "hub-signed-in", token }, origin);
  }

  function signOut() {
    const token = get("token");
    shareSignin(null);
    localStorage.removeItem("token");
    if (token && !DEV) {
      fetch("https://id.twitch.tv/oauth2/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: TWITCH_CLIENT_ID, token }),
      }).catch(() => {});
    }
    location.reload();
  }

  // ===== Twitch API (pictures, colours, checking a name) ===================================

  async function helix(path) {
    const r = await fetch(HELIX + path, { headers: { Authorization: `Bearer ${get("token")}`, "Client-Id": TWITCH_CLIENT_ID } });
    if (r.status === 401) throw new Error("signed out");
    return r;
  }

  function remember(u) {
    ids[u.login] = u.id;
    pics[u.login] = u.profile_image_url;
    put("ids", ids);
    put("pics", pics);
  }

  async function lookUp(login) {
    if (DEV || DEMO) return { login };
    const r = await helix(`/users?login=${encodeURIComponent(login)}`);
    const u = (await r.json()).data?.[0];
    if (!u) return null;
    remember(u);
    return { login: u.login };
  }

  // Profile pictures and chat colours for the dots, once per load (people change them).
  let picsFor = "";
  async function loadPics() {
    const logins = [...new Set([...trusted(), ...requests])];
    if (DEV || DEMO || !logins.length || picsFor === logins.join()) return;
    picsFor = logins.join();
    try {
      const r = await helix(`/users?${logins.map((l) => `login=${encodeURIComponent(l)}`).join("&")}`);
      for (const u of (await r.json()).data || []) remember(u);
      const known = logins.filter((l) => ids[l]);
      if (known.length) {
        const c = await helix(`/chat/color?${known.map((l) => `user_id=${ids[l]}`).join("&")}`);
        for (const u of (await c.json()).data || []) colors[u.user_login] = u.color || "";
        put("colors", colors);
      }
      render();
    } catch {}
  }

  // Black or white, whichever reads better on a colour.
  function inkOn(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.6 ? "#0e0e10" : "#fff";
  }
  const colorOf = (login) => (/^#[0-9a-f]{6}$/i.test(colors[login] || "") ? colors[login] : "");

  // ===== The relay =========================================================================

  let socket = null;
  let retryMs = 1000;
  let pinger = 0;

  function connect() {
    if (!RELAY_URL) return setStatus("Relay not set up yet", "bad");
    const ws = new WebSocket(RELAY_URL);
    socket = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: "auth", token: DEV ? `dev:${DEV}` : get("token") }));
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      retryMs = 1000;
      if (m.t === "state") gotState(m);
      else if (m.t === "q") gotQuestion(m.q);
      else if (m.t === "msg") gotMessage(m.m);
      else if (m.t === "flash") gotFlash(m.f);
      else if (m.t === "flashed") gotFlashed(m);
      else if (m.t === "stats") {
        stats[m.owner] = m.s;
        if (view === "stats") render();
      }
      else if (m.t === "error") gotError(m);
    };
    ws.onclose = (e) => {
      if (ws !== socket) return;
      socket = null;
      if (e.code === 4001) return showSignedOut("Your Twitch sign-in ran out. Sign in again.");
      setStatus("Reconnecting…", "wait");
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    };
    clearInterval(pinger);
    pinger = setInterval(() => socket?.readyState === 1 && socket.send("ping"), 30000); // keeps the line open
  }

  function relay(msg) {
    if (DEMO) return demoRelay(msg);
    if (socket?.readyState !== 1) {
      setStatus("Not connected; try again in a moment", "bad");
      return false;
    }
    socket.send(JSON.stringify(msg));
    return true;
  }

  function gotState(m) {
    const first = !ready;
    connections = m.connections || [];
    requests = m.requests || [];
    tags = m.tags || {};
    rooms = m.rooms || [];
    chat = m.chat || {};
    stats = m.stats || {};
    statsOn = !!m.statsOn;
    collect();
    const had = new Set(Object.keys(questions));
    for (const k of Object.keys(questions)) delete questions[k];
    for (const q of m.questions || []) questions[q.id] = q;
    ready = true;
    setStatus("Online", "ok");
    if (first) moveOldList();
    // Back from granting the stats permission: switch sharing on.
    if (first && !statsOn && get("statsAfterSignin", false) && STATS_SCOPES.every((sc) => me.scopes?.includes(sc))) {
      localStorage.removeItem("statsAfterSignin");
      relay({ t: "statsShare", on: true });
    }
    else if ((m.questions || []).some((q) => !had.has(q.id) && q.to === me.login)) arrived();
    loadPics();
    render();
  }

  function gotQuestion(q) {
    const old = questions[q.id];
    questions[q.id] = q;
    delete pending[q.id];
    // Something new for you: a question to you, or an answer to yours.
    if ((!old && q.to === me.login) || (q.from === me.login && q.answer && !old?.answer)) arrived();
    if (!old && q.from === me.login) {
      askDraft.text = "";
      askDraft.note = "";
      askDraft.options = [...STANDARD]; // options are per question
      askDraft.adding = "";
      if (view === "ask") view = "cards"; // their page shows it in the log
    }
    render();
  }

  // ===== The quick strip ===================================================================
  // Each flash removes itself: info and flagged chat after 2 minutes, love
  // notes after 30 seconds, fuzzily. They're drawn once and left alone, so
  // redrawing the rest of the page doesn't restart their fade.
  const FLASH_MS = { info: 120000, chat: 120000, love: 30000 };
  const FUZZ_MS = 1400;
  const FLASH_ICONS = {
    info: `<path d="M11 2 4 11.5h5L8 18l7-9.5h-5z" ${LINE} stroke-width="1.7"/>`,
    love: '<path d="M10 17s-6.5-4-6.5-8.6A3.6 3.6 0 0 1 10 6.2a3.6 3.6 0 0 1 6.5 2.2C16.5 13 10 17 10 17z" fill="currentColor"/>',
    chat: `<path d="M3 4h14v9H8l-4 3v-3H3z" ${LINE} stroke-width="1.8"/>`,
  };
  const seenFlashes = new Set();

  function gotFlash(f) {
    if (f.to !== me.login || seenFlashes.has(f.id)) return; // flagged chat also goes out for glowing in Twitch chat
    seenFlashes.add(f.id);
    if (f.kind !== "love") arrived();
    const chip = el("div", `qflash qflash--${f.kind}`);
    const color = f.color || colorOf(f.from);
    if (color && f.kind !== "love") chip.style.setProperty("--c", color);
    const icon = el("span", "qflash__icon");
    icon.innerHTML = svg(FLASH_ICONS[f.kind], 15);
    const body = el("div", "qflash__body");
    body.title = f.kind === "chat" ? `${f.chatter}: ${f.text} (flagged by ${f.from})` : `${f.text} (${f.from})`;
    if (f.kind === "chat") {
      body.append(el("b", null, `${f.chatter}: `), document.createTextNode(f.text), el("span", "qflash__who", ` flagged by ${f.from}`));
    } else {
      body.append(document.createTextNode(f.text), el("span", "qflash__who", ` ${f.from}`));
    }
    const leave = () => {
      if (chip.classList.contains("qflash--leaving")) return;
      chip.classList.add("qflash--leaving");
      setTimeout(() => chip.remove(), FUZZ_MS);
    };
    chip.append(icon, body, closeButton(leave, "Clear this"));
    flashesEl.append(chip);
    setTimeout(leave, FLASH_MS[f.kind] - FUZZ_MS);
  }

  function gotFlashed(m) {
    askDraft.note = m.reached ? "" : "They're not online right now, so it didn't go: quick notes don't wait.";
    if (m.reached) {
      askDraft.sent = m.kind;
      setTimeout(() => {
        askDraft.sent = "";
        render();
      }, 2500);
    }
    render();
  }

  function sendFlash(kind, to, text) {
    if (relay({ t: "flash", kind, to, text })) askDraft.text = "";
    render();
  }

  // A chat message. Quiet unless it @mentions you (then the edge glows and,
  // if it's on, the chime plays); the chat button counts what you haven't read.
  function gotMessage(msg) {
    (chat[msg.owner] ||= []).push(msg);
    if (chat[msg.owner].length > 200) chat[msg.owner].shift();
    if (view === "chat" && chatRoom() === msg.owner) markRead(msg.owner);
    else if (msg.from !== me.login && mentions(msg.text)) arrived();
    render();
  }

  const mentions = (text) => new RegExp(`@${me.login}\\b`, "i").test(text);
  function markRead(owner) {
    const last = chat[owner]?.at(-1)?.at || 0;
    const read = get("chatRead", {});
    if ((read[owner] || 0) < last) put("chatRead", { ...read, [owner]: last });
  }
  function unread(owner) {
    const since = get("chatRead", {})[owner] || 0;
    return (chat[owner] || []).filter((m) => m.at > since && m.from !== me.login).length;
  }
  // The room on screen: the one picked, else your own, else the first.
  function chatRoom() {
    if (rooms.some((r) => r.owner === chatDraft.owner)) return chatDraft.owner;
    return (rooms.find((r) => r.owner === me.login) || rooms[0])?.owner || "";
  }

  function gotError(m) {
    for (const k of Object.keys(pending)) delete pending[k];
    if (m.why === "signin") return showSignedOut("Your Twitch sign-in ran out. Sign in again.");
    askDraft.note = `${m.why}.`;
    setStatus(m.why, "bad");
    setTimeout(() => ready && setStatus("Online", "ok"), 6000);
    render();
  }

  // Before the relay, the list lived on this page ("trusted"): hand it over once.
  function moveOldList() {
    const old = get("trusted", null);
    if (!old) return;
    for (const login of old) if (!trusted().includes(login)) relay({ t: "connect", login });
    localStorage.removeItem("trusted");
    for (const k of ["inbox", "sent"]) localStorage.removeItem(k);
  }

  // Something arrived: the edge glows, and the chime plays if it's on.
  function arrived() {
    document.body.classList.remove("flash");
    void document.body.offsetWidth;
    document.body.classList.add("flash");
    chime();
  }

  // Two soft notes, only if switched on (OBS may pick the dock's sound up on stream).
  let audio = null;
  function chime() {
    if (POPOUT || !get("sound", false)) return;
    try {
      audio ||= new AudioContext();
      audio.resume();
      [659, 880].forEach((freq, i) => {
        const o = audio.createOscillator();
        const g = audio.createGain();
        const t = audio.currentTime + i * 0.14;
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        o.connect(g).connect(audio.destination);
        o.start(t);
        o.stop(t + 0.4);
      });
    } catch {}
  }

  // ===== Doing things ======================================================================

  const clean = (s) => s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_LEN);

  function answer(id, code, reply) {
    if (pending[id]) return;
    if (relay({ t: "answer", id, code, text: reply || "" })) {
      pending[id] = true;
      delete drafts[id];
      render();
    }
  }

  function ack(id) {
    if (pending[id]) return;
    if (relay({ t: "seen", id })) {
      pending[id] = true;
      render();
    }
  }

  function dismiss(id) {
    if (relay({ t: "dismiss", id })) {
      pending[id] = true;
      delete drafts[id];
      render();
    }
  }

  function ask(to, question) {
    askDraft.note = "";
    relay({ t: "ask", to, text: question, options: askDraft.options });
  }

  // ===== Pop-outs (OBS) ====================================================================

  // The cards in a window of their own, in front, sized to fit. Null if OBS
  // (or the browser) won't open one. Not from the side panel, which has room.
  let popWin = null;
  function popOut(show = "cards", to = "") {
    if (POPOUT) return window;
    if (EMBED) return null;
    const q = new URLSearchParams({ popout: "", view: show, to });
    if (DEMO) q.set("demo", "");
    if (DEV) q.set("dev", DEV);
    popWin = window.open(`${location.pathname}?${q}`, "streamer-buddy-popout", "popup,width=360,height=520");
    popWin?.focus();
    return popWin;
  }

  // Kept to one row: no room below the bar, so Ask and Connections pop out.
  const short = () => !POPOUT && !EMBED && innerHeight < 120;

  // Ask / Connections / someone's page: here, or popped out if the dock is just the bar.
  function show(next, to = "") {
    if (next === "chat" && to) chatDraft.owner = to;
    if (next === "stats" && to) statsDraft.who = to;
    if (next === "ask" || next === "person") {
      askDraft.to = to || askDraft.to;
      askDraft.note = "";
    }
    if (next !== "cards" && short() && popOut(next, to)) return;
    view = view === next && next !== "person" ? "cards" : next;
    render();
  }

  // ===== Drawing ===========================================================================

  function render() {
    if (!me) return;
    derive();
    // Keep typing where it was if things are redrawn under you.
    const typingIn = document.activeElement?.dataset?.key;
    main.replaceChildren(view === "people" ? peoplePanel() : view === "ask" ? askPanel() : view === "person" ? personPanel(askDraft.to) : view === "chat" ? chatPanel() : view === "stats" ? statsPanel() : cardList());
    if (view === "chat") main.querySelector(".chat__log")?.scrollTo(0, 1e9);
    drawDots();
    drawPeek();
    if (typingIn) {
      const again = document.querySelector(`[data-key="${typingIn}"]`);
      again?.focus();
      again?.setSelectionRange?.(again.value.length, again.value.length);
    }
    askBtn.classList.toggle("pill--on", view === "ask" || (view === "cards" && !short() && get("askOpen", true)));
    peopleBtn.classList.toggle("pill--on", view === "people");
    peopleBtn.classList.toggle("pill--badge", requests.length > 0);
    peopleBtn.title = requests.length ? `Connections (${requests.length} waiting for you to add them back)` : "Connections";
    askBtn.textContent = view === "ask" ? "Cancel" : "Ask";
    drawQuickAsk();
    statsBtn.hidden = !connections.length && !statsOn;
    statsBtn.classList.toggle("pill--on", view === "stats");
    // The chat button: shown once you're in a room or have tags to open one with.
    chatBtn.hidden = !(rooms.length || Object.keys(tags).length);
    chatBtn.classList.toggle("pill--on", view === "chat");
    const n = rooms.reduce((sum, r) => sum + unread(r.owner), 0);
    chatCount.textContent = n ? String(n) : "";
    if (POPOUT) closeWhenDone();
  }

  // The popped-out window goes away a moment after the last thing is dealt with.
  let closing = 0;
  function closeWhenDone() {
    const waiting = Object.values(inbox).some((q) => !q.done) || Object.values(sent).some((q) => q.answer && !q.answer.seen);
    clearTimeout(closing);
    if (ready && !waiting && view === "cards") closing = setTimeout(() => window.close(), 1500);
  }

  // A one-row dock asks right in the bar: who (Everyone, or one person) and a
  // text field; Enter sends with the standard answers. The full Ask window
  // (pick answers, quick questions) is the button beside it.
  function drawQuickAsk() {
    const able = connections.filter((c) => c.mutual).map((c) => c.login);
    const inBar = short() && able.length > 0;
    quickAsk.hidden = askFull.hidden = quickEl.hidden = !inBar;
    askBtn.hidden = inBar || !me;
    if (!inBar) return;
    const choices = targets();
    const want = choices.includes(quickTo.value) ? quickTo.value : choices[0];
    const labels = choices.map(targetLabel);
    if ([...quickTo.options].map((o) => o.text).join() !== labels.join()) {
      quickTo.replaceChildren(...choices.map((l, k) => new Option(labels[k], l)));
    }
    quickTo.value = want;
    drawQuick();
  }

  // Quick questions beside the bar's Ask field: one tap asks whoever the
  // field's picker is set to. × (on hover) forgets one; + adds one.
  let addingQuick = false;
  function drawQuick() {
    const parts = presets().map((text) => {
      const sentNow = quickSent === text;
      const b = el("button", `pill pill--quick${sentNow ? " pill--sent" : ""}`);
      b.type = "button";
      b.title = `Ask ${targetLabel(quickTo.value || "*")}: ${text}`;
      b.append(el("span", null, sentNow ? "Sent ✓" : text));
      const x = el("span", "pill__x", "×");
      x.title = "Forget this quick question";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        put("presets", presets().filter((p) => p !== text));
        render();
      });
      if (!sentNow) b.append(x);
      b.addEventListener("click", () => sendQuick(text));
      return b;
    });
    if (addingQuick) {
      const form = el("form", "quick__add");
      const box = textBox("New quick question");
      box.dataset.key = "quick-add";
      box.maxLength = MAX_LEN;
      box.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          addingQuick = false;
          render();
        }
      });
      box.addEventListener("blur", () => setTimeout(() => {
        if (addingQuick && !box.value.trim()) {
          addingQuick = false;
          render();
        }
      }, 150));
      form.append(box);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = clean(box.value);
        if (text && !presets().includes(text)) put("presets", [...presets(), text].slice(-MAX_PRESETS));
        addingQuick = false;
        render();
      });
      parts.push(form);
      setTimeout(() => box.focus());
    } else if (presets().length < MAX_PRESETS) {
      const add = el("button", "pill pill--icon pill--add", "+");
      add.type = "button";
      add.title = "Add a quick question";
      add.addEventListener("click", () => {
        addingQuick = true;
        render();
      });
      parts.push(add);
    }
    quickEl.replaceChildren(...parts);
  }

  // The dots: one per connection; green ring while online, faded until they've
  // added you back; pulsing in their chat colour for a question from them,
  // ringed for their answer to yours, with how many.
  function drawDots() {
    const dots = connections.map(({ login, mutual, online }) => {
      const asks = Object.values(inbox).filter((q) => q.from === login && !q.done).length;
      const answers = Object.values(sent).filter((q) => q.to === login && q.answer && !q.answer.seen).length;
      const dot = el("button", `dot${asks ? " dot--ask" : answers ? " dot--answer" : ""}${mutual ? "" : " dot--waiting"}`);
      dot.type = "button";
      if (colorOf(login)) {
        dot.style.setProperty("--c", colorOf(login));
        dot.style.setProperty("--ink", inkOn(colorOf(login)));
      }
      if (HIGHLIGHT[login]) {
        dot.style.setProperty("--ring", HIGHLIGHT[login]);
        dot.classList.add("dot--highlight");
      }
      dot.title = !mutual ? `Waiting for ${login} to add you back`
        : asks ? `${login} asked you something`
        : answers ? `${login} answered you`
        : `${login}${online ? " (online)" : ""}`;
      if (pics[login]) {
        const img = el("img");
        img.src = pics[login];
        img.alt = "";
        dot.append(img);
      } else {
        dot.append(el("span", "dot__letter", login[0].toUpperCase()));
      }
      if (online) dot.append(el("span", "dot__online"));
      if (asks + answers) dot.append(el("span", "dot__count", String(asks + answers)));
      dot.addEventListener("click", () => {
        if (asks + answers) {
          view = "cards";
          popOut();
          render();
        } else {
          show("person", login);
        }
      });
      return dot;
    });
    dotsEl.replaceChildren(...dots);
  }

  function cardList() {
    const wrap = el("div", "cards");
    if (signinNote()) wrap.append(signinPill());
    if (!POPOUT) wrap.append(composer(null));
    const answers = Object.keys(sent).filter((id) => sent[id].answer && !sent[id].answer.seen).sort((a, b) => sent[a].answer.at - sent[b].answer.at);
    const waiting = Object.keys(sent).filter((id) => !sent[id].answer && !sent[id].seen).sort((a, b) => sent[a].at - sent[b].at);
    const open = Object.keys(inbox).filter((id) => !inbox[id].done).sort((a, b) => inbox[a].at - inbox[b].at);
    const replied = Object.keys(inbox).filter((id) => inbox[id].answered && !inbox[id].cleared).sort((a, b) => inbox[a].answered.at - inbox[b].answered.at);
    for (const login of requests) wrap.append(requestRow(login));
    for (const id of answers) wrap.append(answerCard(id));
    for (const id of open) wrap.append(questionCard(id));
    for (const id of replied) wrap.append(repliedCard(id));
    // One row per question; asking everyone shows as one row.
    const shown = new Set();
    for (const id of waiting) {
      const key = sent[id].group || id;
      if (!shown.has(key)) wrap.append(waitingRow(id));
      shown.add(key);
    }
    // With connections, the dots say it all: nothing here, so the dock can be one row.

    return wrap;
  }

  // Someone added you: add them back to connect.
  function requestRow(login) {
    const row = el("div", "waiting request");
    row.append(el("div", "waiting__text", `${login} wants to connect`));
    const add = el("button", "pill pill--on", "Add back");
    add.type = "button";
    add.addEventListener("click", () => relay({ t: "connect", login }));
    row.append(add);
    return row;
  }

  function questionCard(id) {
    const q = inbox[id];
    const card = el("div", "qcard");
    card.setAttribute("role", "alertdialog");
    card.append(el("div", "qcard__head", `${q.name} asks${q.group ? ` ${askedWho(q)}` : ""}`), el("div", "qcard__text", q.text));
    const buttons = el("div", "qcard__answers");
    for (const { code, label } of optionsOf(q)) {
      const b = el("button", `qcard__answer answer--${code}${code === "x" ? " qcard__answer--own" : ""}`);
      b.type = "button";
      b.disabled = q.sending;
      if (code !== "x") b.innerHTML = svg(ANSWERS[code].icon);
      b.append(el("span", null, label));
      b.addEventListener("click", () => answer(id, code, code === "x" ? label : ""));
      buttons.append(b);
    }
    const own = el("form", "qcard__own");
    const input = textBox("Or type your own reply", drafts[id] || "");
    input.dataset.key = `reply-${id}`;
    input.maxLength = MAX_LEN;
    input.addEventListener("input", () => (drafts[id] = input.value));
    const send = el("button", null, q.sending ? "Sending…" : "Send");
    send.type = "submit";
    send.disabled = q.sending;
    own.append(input, send);
    own.addEventListener("submit", (e) => {
      e.preventDefault();
      const reply = clean(input.value);
      if (reply) answer(id, "c", reply);
    });
    const x = el("button", "qcard__dismiss", "Dismiss without answering");
    x.type = "button";
    x.addEventListener("click", () => dismiss(id));
    card.append(buttons, own, x);
    return card;
  }

  // Their answer to a question you asked.
  function answerCard(id) {
    const q = sent[id];
    const a = ANSWERS[q.answer.code];
    const card = el("div", "acard");
    const icon = el("div", `acard__icon answer--${q.answer.code}`);
    icon.innerHTML = svg(a.icon, 20);
    const body = el("div", "acard__body");
    body.append(
      el("div", "acard__who", `${q.to} answered`),
      el("div", "acard__head", said(q.answer)),
      el("div", "acard__question", q.group ? `${q.text} (asked ${askedWho(q)})` : q.text),
    );
    body.append(seenControl(id, q.answer, "receipt receipt--btn"));
    card.append(icon, body, closeButton(() => setUi(id, { closed: true })));
    return card;
  }

  // "Mark as seen" (tells them), "Sending…", or "✓ Seen".
  function seenControl(id, answerInfo, className) {
    if (answerInfo.acked === true) return el("span", "receipt receipt--seen", "✓ Seen");
    const seen = el("button", className, answerInfo.acked === "sending" ? "Sending…" : "Mark as seen");
    seen.type = "button";
    seen.title = "Let them know you've seen this";
    seen.disabled = answerInfo.acked === "sending";
    seen.addEventListener("click", () => ack(id));
    return seen;
  }

  // Your answer to their question, until you close it: "✓ Seen" once they've
  // tapped Mark as seen.
  function repliedCard(id) {
    const q = inbox[id];
    const a = ANSWERS[q.answered.code];
    const card = el("div", "rcard");
    const icon = el("div", `rcard__icon answer--${q.answered.code}`);
    icon.innerHTML = svg(a.icon, 16);
    const body = el("div", "rcard__body");
    const head = el("div", "rcard__head");
    head.append(el("span", null, `You answered ${q.name}: `), el("b", null, said(q.answered)));
    body.append(head, el("div", "rcard__question", q.text));
    body.append(q.seenAt ? el("span", "receipt receipt--seen", "✓ Seen") : el("span", "receipt", "Sent"));
    card.append(icon, body, closeButton(() => setUi(id, { cleared: true })));
    return card;
  }

  // The bar's preview: the newest question to you, with its answers, or else
  // the newest answer to a question of yours, or else a connection request.
  // "+N" for the rest.
  function drawPeek() {
    const open = Object.keys(inbox).filter((id) => !inbox[id].done).sort((a, b) => inbox[b].at - inbox[a].at);
    const answers = Object.keys(sent).filter((id) => sent[id].answer && !sent[id].answer.seen).sort((a, b) => sent[b].answer.at - sent[a].answer.at);
    const parts = [];
    const who = (login, text) => {
      const name = el("span", "peek__who", text);
      if (colorOf(login)) name.style.color = colorOf(login);
      return name;
    };
    if (open.length) {
      const id = open[0];
      const q = inbox[id];
      const line = el("div", "peek__line");
      line.title = q.text;
      line.append(who(q.from, q.name), el("span", "peek__text", q.text));
      const buttons = el("div", "peek__answers");
      for (const { code, label } of optionsOf(q)) {
        const b = el("button", `pill pill--answer answer--${code}${code === "x" ? " pill--own" : ""}`);
        b.type = "button";
        b.title = label;
        b.disabled = q.sending;
        if (code !== "x") b.innerHTML = svg(ANSWERS[code].icon, 15);
        b.append(el("span", "pill__label", label));
        b.addEventListener("click", () => answer(id, code, code === "x" ? label : ""));
        buttons.append(b);
      }
      const own = el("form", "peek__own");
      const input = textBox("Reply…", drafts[id] || "");
      input.dataset.key = `peek-${id}`;
      input.maxLength = MAX_LEN;
      input.addEventListener("input", () => (drafts[id] = input.value));
      own.append(input);
      own.addEventListener("submit", (e) => {
        e.preventDefault();
        const reply = clean(input.value);
        if (reply) answer(id, "c", reply);
      });
      parts.push(line, buttons, own, closeButton(() => dismiss(id), "Dismiss without answering"));
    } else if (answers.length) {
      const id = answers[0];
      const q = sent[id];
      const a = ANSWERS[q.answer.code];
      const line = el("div", "peek__line");
      line.title = q.text;
      const icon = el("span", `peek__icon answer--${q.answer.code}`);
      icon.innerHTML = svg(a.icon, 15);
      line.append(who(q.to, `${q.to} answered`), icon, el("b", "peek__answer", said(q.answer)), el("span", "peek__text peek__text--muted", q.text));
      parts.push(line, seenControl(id, q.answer, "pill"), closeButton(() => setUi(id, { closed: true })));
    } else if (requests.length) {
      const login = requests[0];
      const line = el("div", "peek__line");
      line.append(who(login, login), el("span", "peek__text peek__text--muted", "wants to connect"));
      const add = el("button", "pill pill--on", "Add back");
      add.type = "button";
      add.addEventListener("click", () => relay({ t: "connect", login }));
      parts.push(line, add);
    }
    if (signinNote()) parts.unshift(signinPill());
    const more = open.length + answers.length - (open.length || answers.length ? 1 : 0);
    if (more > 0) {
      const b = el("button", "pill pill--more", `+${more}`);
      b.type = "button";
      b.title = "See them all";
      b.addEventListener("click", () => {
        view = "cards";
        if (short()) popOut();
        render();
      });
      parts.push(b);
    }
    peekEl.replaceChildren(...parts);
  }

  // A question you asked that hasn't been answered yet (for everyone: how
  // many have answered so far).
  function waitingRow(id) {
    const q = sent[id];
    const copies = q.group ? Object.entries(sent).filter(([, c]) => c.group === q.group) : [[id, q]];
    const answered = copies.filter(([, c]) => c.answer).length;
    const row = el("div", "waiting");
    const text = el("div", "waiting__text");
    const who = q.group ? `Waiting on ${askedWho(q)} (${answered} of ${copies.length} answered): ` : `Waiting on ${q.to}: `;
    text.append(el("span", "waiting__who", who), document.createTextNode(q.text));
    row.append(text, closeButton(() => {
      for (const [cid] of copies) ui[cid] = { ...ui[cid], waitClosed: true };
      setUi(id, {});
    }, "Stop showing this"));
    return row;
  }

  function closeButton(onClick, title = "Close") {
    const x = el("button", "x", "×");
    x.type = "button";
    x.title = title;
    x.addEventListener("click", onClick);
    return x;
  }

  let pickerOpen = false; // the Ask box's who-to drop-down

  // Quick questions: saved on this device; in a one-row bar they're one tap
  // to everyone.
  const MAX_PRESETS = 8;
  const presets = () => get("presets", ["Clip that!", "Anyone free to help?"]);
  let quickSent = ""; // the quick question just sent, shown as "Sent" for a moment

  function sendQuick(text) {
    if (relay({ t: "ask", to: quickTo.value || "*", text, options: STANDARD })) {
      quickSent = text;
      render();
      setTimeout(() => {
        quickSent = "";
        render();
      }, 2500);
    }
  }

  // A person as a chip: picture (bright ring if highlighted), name, online dot.
  function personChip(login, className) {
    const chip = el("button", className);
    chip.type = "button";
    if (login === "*" || login.startsWith("#")) {
      const icon = el("span", `ask__everyone${login === "*" ? "" : " ask__everyone--tag"}`);
      icon.innerHTML = login === "*" ? PEOPLE_ICON : TAG_ICON;
      chip.append(icon, el("span", "ask__name", targetLabel(login)));
      return chip;
    }
    if (HIGHLIGHT[login]) chip.style.setProperty("--ring", HIGHLIGHT[login]);
    if (pics[login]) {
      const img = el("img");
      img.src = pics[login];
      img.alt = "";
      chip.append(img);
    }
    chip.append(el("span", "ask__name", login));
    if (conn(login)?.online) chip.append(el("span", "ask__online"));
    return chip;
  }

  // Ask one of your connections a question (a pop-out from a one-row bar).
  function askPanel() {
    const panel = el("div", "panel");
    panel.append(composer(null, true));
    return panel;
  }

  // The Ask box, open at the top unless you fold it away (remembered). Pick
  // who (a row of their pictures; fixed on someone's page), write the
  // question, and choose its answer buttons: × takes a standard one off for
  // this question, "Add option" puts your own on. Typing a reply is always
  // open to them.
  function composer(fixedTo, alwaysOpen = false) {
    const box = el("section", "ask");
    const able = connections.filter((c) => c.mutual).map((c) => c.login);
    const open = alwaysOpen || get("askOpen", true);
    const head = el("button", "ask__head");
    head.type = "button";
    head.append(el("span", "ask__title", fixedTo ? `To ${fixedTo}` : "Send"));
    if (!alwaysOpen) head.append(el("span", `ask__chev${open ? " ask__chev--open" : ""}`));
    head.addEventListener("click", () => {
      if (alwaysOpen) return;
      put("askOpen", !open);
      render();
    });
    box.append(head);
    if (!open) return box;
    // What you're sending: a question, a fast note, or a love note.
    const modes = el("div", "ask__modes");
    for (const [mode, label] of [["ask", "Ask"], ["info", "Quick info"], ["love", "Love note"]]) {
      const b = el("button", `ask__mode${askDraft.mode === mode ? " ask__mode--on" : ""}`, label);
      b.type = "button";
      b.addEventListener("click", () => {
        askDraft.mode = mode;
        askDraft.note = "";
        render();
      });
      modes.append(b);
    }
    box.append(modes);
    if (!fixedTo && !able.length) {
      box.append(el("p", "ask__hint", "Add someone under Connections first. You can ask each other once you've both added each other."));
      return box;
    }

    // Who to ask: the chosen person, with a caret that drops down the rest.
    if (!fixedTo) {
      if (!targets().includes(askDraft.to)) askDraft.to = targets()[0];
      const who = el("div", "ask__who");
      const pick = personChip(askDraft.to, "ask__person ask__person--on");
      pick.append(el("span", `ask__caret${pickerOpen ? " ask__caret--open" : ""}`));
      pick.title = "Ask someone else";
      pick.addEventListener("click", () => {
        pickerOpen = !pickerOpen;
        render();
      });
      who.append(pick);
      if (pickerOpen) {
        const list = el("div", "ask__menu");
        for (const login of targets()) {
          const row = personChip(login, `ask__menuitem${login === askDraft.to ? " ask__menuitem--on" : ""}`);
          row.addEventListener("click", () => {
            askDraft.to = login;
            pickerOpen = false;
            render();
          });
          list.append(row);
        }
        if (able.length === 1) list.append(el("div", "ask__menuhint", "Add more people under Connections."));
        who.append(list);
      }
      box.append(who);
    }
    const to = () => fixedTo || askDraft.to;

    const form = el("form", "ask__form");
    const mode = askDraft.mode;
    const input = textBox(mode === "love" ? "Leave a little love (or poke some fun)" : mode === "info" ? "What do they need to know?" : "What do you want to ask?", askDraft.text);
    input.dataset.key = fixedTo ? `ask-${fixedTo}` : "ask";
    input.className = "ask__input";
    input.maxLength = mode === "love" ? 80 : MAX_LEN;
    input.addEventListener("input", () => (askDraft.text = input.value));
    const send = el("button", "ask__send");
    send.type = "submit";
    send.title = "Send";
    send.setAttribute("aria-label", "Send");
    send.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 16V4M5 9l5-5 5 5"/></svg>`;
    const save = el("button", "ask__save", "☆");
    save.setAttribute("aria-label", "Save as a quick question");
    save.type = "button";
    save.title = "Save as a quick question";
    save.addEventListener("click", () => {
      const question = clean(input.value);
      if (!question || presets().includes(question)) return;
      put("presets", [...presets(), question].slice(-MAX_PRESETS));
      render();
    });
    form.append(input);
    if (mode === "ask") form.append(save);
    form.append(send);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const question = clean(input.value);
      if (!question) return;
      if (mode === "ask") ask(to(), question);
      else sendFlash(mode, to(), question);
    });
    box.append(form);

    // Quick info and love notes are just the text; say how long they show.
    if (mode !== "ask") {
      box.append(el("p", "ask__hint", askDraft.sent === mode ? "Sent ✓"
        : mode === "love" ? "Fades in on their bar with your name, and fades away after 30 seconds."
        : "Shows on their bar with your name for 2 minutes. Only reaches people who are online."));
      if (askDraft.note) box.append(el("p", "ask__note", askDraft.note));
      return box;
    }

    // Quick questions: tap one to put it in the box; × forgets it.
    if (presets().length) {
      box.append(el("div", "ask__label", "Quick questions"));
      const quick = el("div", "ask__options");
      for (const text of presets()) {
        const chip = el("span", "ask__option ask__quick");
        const use = el("button", "ask__quickuse", text);
        use.type = "button";
        use.title = "Put this in the box";
        use.addEventListener("click", () => {
          askDraft.text = text;
          render();
          document.querySelector(`[data-key="${input.dataset.key}"]`)?.focus();
        });
        const x = el("button", "ask__optx", "×");
        x.type = "button";
        x.title = "Forget this quick question";
        x.addEventListener("click", () => {
          put("presets", presets().filter((p) => p !== text));
          render();
        });
        chip.append(use, x);
        quick.append(chip);
      }
      box.append(quick);
    }

    // Their answer buttons for this question.
    box.append(el("div", "ask__label", "Answer buttons"));
    const chips = el("div", "ask__options");
    for (const o of askDraft.options) {
      const own = o.startsWith("+");
      const chip = el("span", `ask__option${own ? " ask__option--own" : ""}`);
      if (!own) {
        const icon = el("span", `answer--${o}`);
        icon.innerHTML = svg(ANSWERS[o].icon, 13);
        chip.append(icon);
      }
      chip.append(el("span", null, own ? o.slice(1) : ANSWERS[o].label));
      const x = el("button", "ask__optx", "×");
      x.type = "button";
      x.title = "Take this off for this question";
      x.addEventListener("click", () => {
        askDraft.options = askDraft.options.filter((v) => v !== o);
        render();
      });
      chip.append(x);
      chips.append(chip);
    }
    if (askDraft.options.length < MAX_OPTIONS) {
      const addForm = el("form", "ask__add");
      const add = textBox("+ Add option", askDraft.adding);
      add.dataset.key = "ask-add";
      add.maxLength = 30;
      add.addEventListener("input", () => (askDraft.adding = add.value));
      addForm.append(add);
      addForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const label = clean(add.value).slice(0, 30);
        if (label && !askDraft.options.includes(`+${label}`)) askDraft.options = [...askDraft.options, `+${label}`];
        askDraft.adding = "";
        render();
      });
      chips.append(addForm);
    }
    box.append(chips);
    const changed = askDraft.options.join() !== STANDARD.join();
    const foot = el("div", "ask__foot");
    foot.append(el("span", "ask__hint", askDraft.options.length ? "They can also type their own reply." : "They'll type their reply."));
    if (changed) {
      const reset = el("button", "ask__reset", "Back to the standard six");
      reset.type = "button";
      reset.addEventListener("click", () => {
        askDraft.options = [...STANDARD];
        render();
      });
      foot.append(reset);
    }
    box.append(foot);
    if (askDraft.note) box.append(el("p", "ask__note", askDraft.note));
    return box;
  }

  // One person's page: ask them something, and the log of everything between
  // you, newest first. Waiting questions to you show as full cards on top.
  function personPanel(login) {
    const c = conn(login) || { login, mutual: false, online: false };
    const panel = el("div", "panel person");
    const head = el("div", "person__head");
    if (pics[login]) {
      const img = el("img", "person__pic");
      img.src = pics[login];
      img.alt = "";
      head.append(img);
    }
    const name = el("span", "person__name", login);
    if (colorOf(login)) name.style.color = colorOf(login);
    head.append(name, el("span", `person__state${c.online ? " person__state--on" : ""}`, !c.mutual ? "hasn't added you yet" : c.online ? "online" : "offline"));
    panel.append(head);
    if (c.mutual) panel.append(composer(login));

    for (const id of Object.keys(inbox).filter((id) => inbox[id].from === login && !inbox[id].done)) panel.append(questionCard(id));

    // Everything finished or waiting on them, newest first.
    const rows = [
      ...Object.entries(inbox).filter(([, q]) => q.from === login && q.done && !q.gone).map(([id, q]) => ({ id, q, mine: false })),
      ...Object.entries(sent).filter(([, q]) => q.to === login && !q.gone).map(([id, q]) => ({ id, q, mine: true })),
    ].sort((a, b) => b.q.at - a.q.at);
    const logHead = el("div", "log__head");
    logHead.append(el("span", null, "History"));
    if (rows.length) {
      const all = el("button", "pill", "Clear all");
      all.type = "button";
      all.addEventListener("click", () => {
        for (const { id } of rows) ui[id] = { ...ui[id], gone: true };
        setUi(rows[0].id, {});
      });
      logHead.append(all);
    }
    panel.append(logHead);
    if (!rows.length) panel.append(el("p", "panel__sub", "Nothing yet."));
    for (const { id, q, mine } of rows) panel.append(logRow(id, q, mine, login));
    return panel;
  }

  // One line of history: who asked what, what came back, and if it was seen.
  function logRow(id, q, mine, login) {
    const row = el("div", "log__row");
    const body = el("div", "log__body");
    body.append(el("div", "log__who", `${mine ? "You asked" : `${login} asked`} · ${ago(q.at)}`), el("div", "log__q", q.text));
    const out = el("div", "log__a");
    const reply = mine ? q.answer : q.answered;
    if (reply) {
      const a = ANSWERS[reply.code];
      const icon = el("span", `log__icon answer--${reply.code}`);
      icon.innerHTML = svg(a.icon, 13);
      out.append(icon, el("b", null, said(reply)));
      // Seen: on their answer, that you marked it; on yours, that they did.
      if (mine) out.append(seenControl(id, reply, "pill"));
      else out.append(el("span", `receipt${q.seenAt ? " receipt--seen" : ""}`, q.seenAt ? "✓ Seen" : "Not seen yet"));
    } else {
      out.append(el("span", "receipt", mine ? (q.seen ? "Dismissed" : "Waiting for their answer") : "Dismissed"));
    }
    body.append(out);
    row.append(body, closeButton(() => setUi(id, { gone: true }), "Clear from history"));
    return row;
  }

  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
  }

  // Mod chat: one room per streamer, open to one of their tags. Pick a room
  // (if you're in more than one), read and post; the owner picks the tag or
  // closes the room. @name pings someone.
  function chatPanel() {
    const panel = el("div", "panel chat");
    const owner = chatRoom();
    const room = rooms.find((r) => r.owner === owner);
    const mine = rooms.find((r) => r.owner === me.login);

    if (rooms.length > 1) {
      const pick = el("div", "chat__rooms");
      for (const r of rooms) {
        const n = unread(r.owner);
        const b = el("button", `pill${r.owner === owner ? " pill--on" : ""}`, r.owner === me.login ? "Your room" : `${r.owner}'s room`);
        b.type = "button";
        if (n) b.append(el("span", "pill__count", String(n)));
        b.addEventListener("click", () => {
          chatDraft.owner = r.owner;
          render();
        });
        pick.append(b);
      }
      panel.append(pick);
    }

    if (!room) {
      panel.append(el("div", "panel__head", "Mod chat"));
      const names = Object.keys(tags).sort();
      if (!names.length) {
        panel.append(el("p", "panel__sub", "No rooms yet. A streamer opens a room for a tag (like Mods) and everyone in it can talk here."));
        return panel;
      }
      panel.append(el("p", "panel__sub", "Open a room for one of your tags. Everyone in it can talk to each other here, and you can read along (it stays quiet for you unless someone @mentions you)."));
      panel.append(roomPicker(null, "Open room"));
      return panel;
    }

    const head = el("div", "chat__head");
    head.append(el("span", "chat__title", room.owner === me.login ? `Your room · ${room.tag}` : `${room.owner}'s room · ${room.tag}`));
    const who = el("span", "chat__who");
    for (const m of room.members) {
      const dot = el("span", `chat__member${m.online ? " chat__member--on" : ""}`, m.login);
      if (colorOf(m.login)) dot.style.color = colorOf(m.login);
      who.append(dot);
    }
    head.append(who);
    panel.append(head);

    const log = el("div", "chat__log");
    const msgs = chat[owner] || [];
    if (!msgs.length) log.append(el("p", "panel__sub", "No messages yet. Say hi."));
    let lastDay = "";
    for (const m of msgs) {
      const day = new Date(m.at).toDateString();
      if (day !== lastDay && lastDay) log.append(el("div", "chat__day", new Date(m.at).toLocaleDateString()));
      lastDay = day;
      const line = el("div", `chat__msg${mentions(m.text) && m.from !== me.login ? " chat__msg--mention" : ""}`);
      const name = el("span", "chat__from", m.from);
      if (colorOf(m.from)) name.style.color = colorOf(m.from);
      line.append(name, el("span", "chat__time", new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })), el("div", "chat__text", m.text));
      log.append(line);
    }
    panel.append(log);
    markRead(owner);

    const form = el("form", "ask__form chat__form");
    const input = textBox("Message the room…", chatDraft.text);
    input.className = "ask__input";
    input.dataset.key = "chat";
    input.maxLength = 500;
    input.addEventListener("input", () => (chatDraft.text = input.value));
    const send = el("button", "ask__send");
    send.type = "submit";
    send.title = "Send";
    send.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 16V4M5 9l5-5 5 5"/></svg>`;
    form.append(input, send);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (text && relay({ t: "say", owner, text })) {
        chatDraft.text = "";
        input.value = "";
      }
    });
    panel.append(form);
    setTimeout(() => document.activeElement === document.body && input.focus());

    if (mine && owner === me.login) panel.append(roomPicker(mine.tag, "Change"));
    return panel;
  }

  // The owner's room settings: which tag it's open to, or close it.
  function roomPicker(current, label) {
    const row = el("form", "chat__settings");
    row.append(el("span", "chat__label", current ? "Open to" : "Tag"));
    const pick = el("select", "panel__select");
    for (const t of Object.keys(tags).sort()) pick.append(new Option(`${t} (${tags[t].length})`, t, false, t === current));
    const go = el("button", "pill pill--on", label);
    go.type = "submit";
    row.append(pick, go);
    row.addEventListener("submit", (e) => {
      e.preventDefault();
      relay({ t: "room", tag: pick.value });
    });
    if (current) {
      const close = el("button", "pill", "Close room");
      close.type = "button";
      close.addEventListener("click", () => relay({ t: "room", tag: null }));
      row.append(close);
    }
    return row;
  }

  // Connections: who you can ask and who can ask you, once both have added
  // each other; requests from people who've added you.
  function peoplePanel() {
    const panel = el("div", "panel");
    panel.append(
      el("div", "panel__head", "Connections"),
      el("p", "panel__sub", "You can ask each other once you've both added each other. Tag people (Mods, Lead mods, Tech…) to ask a whole group at once; only you see your tags."),
    );
    const form = el("form", "panel__form");
    const input = textBox("Their Twitch name");
    const add = el("button", null, "Add");
    add.type = "submit";
    const note = el("p", "panel__note");
    form.append(input, add);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const login = input.value.trim().replace(/^@/, "").toLowerCase();
      if (!/^[a-z0-9_]{2,25}$/.test(login)) return void (note.textContent = "That isn't a Twitch username.");
      if (trusted().includes(login)) return void (note.textContent = `${login} is already on your list.`);
      add.disabled = true;
      note.textContent = "";
      const user = await lookUp(login).catch(() => null);
      add.disabled = false;
      if (!user) return void (note.textContent = `Couldn't find ${login} on Twitch.`);
      input.value = "";
      input.blur();
      relay({ t: "connect", login: user.login });
    });
    panel.append(form, note);

    const list = el("div", "people__list");
    for (const login of requests) {
      const row = el("div", "people__row");
      const back = el("button", "pill pill--on", "Add back");
      back.type = "button";
      back.addEventListener("click", () => relay({ t: "connect", login }));
      row.append(el("span", "people__name", login), el("span", "people__state", "wants to connect"), back);
      list.append(row);
    }
    // Tag suggestions: your own tags, plus a few common ones.
    const names = el("datalist");
    names.id = "tag-names";
    for (const t of [...new Set([...Object.keys(tags).sort(), "Mods", "Lead mods", "Tech"])]) names.append(new Option(t));
    panel.append(names);
    for (const { login, mutual, online } of connections) {
      const row = el("div", "people__row");
      row.append(
        el("span", "people__name", login),
        el("span", `people__state${online ? " people__state--on" : ""}`, !mutual ? "hasn't added you yet" : online ? "online" : "offline"),
        closeButton(() => relay({ t: "disconnect", login }), `Remove ${login}`),
      );
      // Their tags, each with ×, and a box to add one.
      const tagRow = el("div", "people__tags");
      for (const t of Object.keys(tags).sort().filter((t) => tags[t].includes(login))) {
        const chip = el("span", "tagchip", t);
        const x = el("button", "tagchip__x", "×");
        x.type = "button";
        x.title = `Take ${login} out of ${t}`;
        x.addEventListener("click", () => relay({ t: "tag", login, tag: t, on: false }));
        chip.append(x);
        tagRow.append(chip);
      }
      const addTag = el("form", "tagadd");
      const box = textBox("+ Tag");
      box.dataset.key = `tag-${login}`;
      box.maxLength = 20;
      box.setAttribute("list", "tag-names");
      addTag.append(box);
      addTag.addEventListener("submit", (e) => {
        e.preventDefault();
        const tag = clean(box.value).slice(0, 20);
        if (tag) relay({ t: "tag", login, tag, on: true });
        box.value = "";
      });
      tagRow.append(addTag);
      list.append(row, tagRow);
    }
    if (!connections.length && !requests.length) list.append(el("p", "panel__sub", "Nobody yet."));
    panel.append(list);

    // Sound, off unless wanted.
    const sound = el("label", "panel__check");
    const box = el("input");
    box.type = "checkbox";
    box.checked = get("sound", false);
    box.addEventListener("change", () => {
      put("sound", box.checked);
      if (box.checked) chime();
    });
    sound.append(box, document.createTextNode(" Chime when something arrives"));
    panel.append(sound, el("p", "panel__sub", "In OBS: if it captures your desktop audio, viewers may hear it too."));

    const out = el("button", "panel__signout", `Sign out of ${me.login}`);
    out.type = "button";
    out.addEventListener("click", signOut);
    panel.append(out);
    return panel;
  }

  function showSignedOut(message) {
    me = null;
    socket?.close();
    socket = null;
    askBtn.hidden = peopleBtn.hidden = quickAsk.hidden = askFull.hidden = chatBtn.hidden = statsBtn.hidden = true;
    dotsEl.replaceChildren();
    const again = el("button", "pill pill--warn pill--bad", message ? "Signed out · Sign in with Twitch" : "Sign in with Twitch");
    again.type = "button";
    again.addEventListener("click", signIn);
    peekEl.replaceChildren(again);
    setStatus("");
    const box = el("div", "signin");
    box.append(el("div", "signin__head", "Streamer Buddy System"), el("p", "signin__sub", "Quick questions between you and the people you've connected with."));
    if (message) box.append(el("p", "signin__error", message));
    const b = el("button", "signin__btn", "Sign in with Twitch");
    b.type = "button";
    b.addEventListener("click", signIn);
    box.append(b);
    main.replaceChildren(box);
  }

  function showMessage(head, sub) {
    const box = el("div", "signin");
    box.append(el("div", "signin__head", head), el("p", "signin__sub", sub));
    main.replaceChildren(box);
  }

  // ===== Stats: what's public ==============================================================
  // Anyone signed in can read these for any channel.

  async function fetchPublic(id) {
    const out = { at: Date.now() };
    const json = async (path) => (await helix(path)).json();
    const [streams, followers, chatSet, schedule, clips] = await Promise.allSettled([
      json(`/streams?user_id=${id}`),
      json(`/channels/followers?broadcaster_id=${id}&first=1`),
      json(`/chat/settings?broadcaster_id=${id}`),
      json(`/schedule?broadcaster_id=${id}&first=1`),
      json(`/clips?broadcaster_id=${id}&first=20&started_at=${new Date(Date.now() - 30 * 86400000).toISOString()}`),
    ]);
    const st = streams.value?.data?.[0];
    Object.assign(out, { live: !!st, viewers: st?.viewer_count || 0, startedAt: st?.started_at || "", game: st?.game_name || "", title: st?.title || "" });
    if (followers.value?.total != null) out.followers = followers.value.total;
    const c = chatSet.value?.data?.[0];
    if (c) {
      const modes = [];
      if (c.slow_mode) modes.push(`Slow (${c.slow_mode_wait_time}s)`);
      if (c.follower_mode) modes.push("Followers only");
      if (c.subscriber_mode) modes.push("Subs only");
      if (c.emote_mode) modes.push("Emotes only");
      out.chatMode = modes.join(", ") || "Normal";
    }
    const seg = schedule.value?.data?.segments?.[0];
    if (seg) out.nextStream = `${seg.start_time}|${seg.title || ""}`;
    const clip = (clips.value?.data || []).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (clip) out.clip = { title: clip.title, url: clip.url, at: clip.created_at };
    return out;
  }

  // ===== Stats: the streamer's own panel collects =========================================
  // Only the OBS dock itself (not pop-outs or the side panel, so nothing's
  // counted twice), once sharing is on and Twitch has granted the permission.

  let collecting = false;
  function collect() {
    if (collecting || !statsOn || POPOUT || EMBED || DEV || DEMO || !me?.id) return;
    if (!STATS_SCOPES.every((sc) => me.scopes?.includes(sc))) return;
    collecting = true;
    takeSample();
    setInterval(takeSample, SAMPLE_MS);
    listenForEvents();
  }

  async function takeSample() {
    if (!me) return;
    try {
      const s = await fetchPublic(me.id);
      const subs = await (await helix(`/subscriptions?broadcaster_id=${me.id}&first=1`)).json();
      if (subs.total != null) s.subsTotal = subs.total;
      const ads = await (await helix(`/channels/ads?broadcaster_id=${me.id}`)).json();
      s.adNext = ads.data?.[0]?.next_ad_at || "";
      const d = new Date();
      s.day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      relay({ t: "sample", s });
    } catch {}
  }

  // Twitch's live events for her channel; the relay does the adding up.
  let eventSocket = null;
  function listenForEvents(url = "wss://eventsub.wss.twitch.tv/ws", isReconnect = false) {
    const ws = new WebSocket(url);
    if (!eventSocket) eventSocket = ws;
    let quiet = 0;
    const feed = (sec = 10) => {
      clearTimeout(quiet);
      quiet = setTimeout(() => ws.close(), (sec + 10) * 1000); // Twitch went quiet
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const type = m.metadata?.message_type;
      feed();
      if (type === "session_welcome") {
        feed(m.payload.session.keepalive_timeout_seconds || 10);
        const old = eventSocket;
        eventSocket = ws;
        if (isReconnect && old !== ws) old?.close(); // subscriptions carry over
        else subscribeEvents(m.payload.session.id);
      } else if (type === "session_reconnect") {
        listenForEvents(m.payload.session.reconnect_url, true);
      } else if (type === "notification") {
        gotEvent(m.metadata.subscription_type, m.payload.event);
      }
    };
    ws.onclose = () => {
      clearTimeout(quiet);
      if (ws !== eventSocket) return; // an old one being swapped out
      eventSocket = null;
      if (me) setTimeout(() => listenForEvents(), 5000);
    };
  }

  async function subscribeEvents(session) {
    const id = me.id;
    const wanted = [
      ["channel.subscribe", "1", { broadcaster_user_id: id }],
      ["channel.subscription.message", "1", { broadcaster_user_id: id }],
      ["channel.subscription.gift", "1", { broadcaster_user_id: id }],
      ["channel.cheer", "1", { broadcaster_user_id: id }],
      ["channel.follow", "2", { broadcaster_user_id: id, moderator_user_id: id }],
      ["channel.raid", "1", { from_broadcaster_user_id: id }],
      ["channel.raid", "1", { to_broadcaster_user_id: id }],
      ["channel.hype_train.begin", "2", { broadcaster_user_id: id }],
      ["channel.hype_train.progress", "2", { broadcaster_user_id: id }],
      ["channel.hype_train.end", "2", { broadcaster_user_id: id }],
    ];
    for (const [type, version, condition] of wanted) {
      fetch(`${HELIX}/eventsub/subscriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${get("token")}`, "Client-Id": TWITCH_CLIENT_ID, "Content-Type": "application/json" },
        body: JSON.stringify({ type, version, condition, transport: { method: "websocket", session_id: session } }),
      }).catch(() => {});
    }
  }

  function gotEvent(type, ev) {
    const send = (m) => relay({ t: "statEvent", ...m });
    if (type === "channel.subscribe") {
      if (!ev.is_gift) send({ kind: "sub", n: 1 }); // a gifted sub is counted by its gift
    } else if (type === "channel.subscription.message") send({ kind: "sub", n: 1 });
    else if (type === "channel.subscription.gift") send({ kind: "gift", n: ev.total, who: ev.is_anonymous ? "Anonymous" : ev.user_name });
    else if (type === "channel.cheer") send({ kind: "bits", n: ev.bits });
    else if (type === "channel.follow") send({ kind: "follow", n: 1 });
    else if (type === "channel.raid") {
      if (ev.from_broadcaster_user_id === me.id) send({ kind: "raidOut", who: ev.to_broadcaster_user_name, viewers: ev.viewers });
      else send({ kind: "raidIn", who: ev.from_broadcaster_user_name, viewers: ev.viewers });
    } else if (type === "channel.hype_train.end") send({ kind: "hype", hype: null });
    else if (type.startsWith("channel.hype_train")) send({ kind: "hype", hype: { level: ev.level, progress: ev.progress, goal: ev.goal, ends: ev.expires_at } });
  }

  // ===== Stats: the tab ====================================================================

  // Whose stats: the one picked, else someone sharing, else the first connection, else you.
  function statsWho() {
    const people = statsPeople();
    if (people.includes(statsDraft.who)) return statsDraft.who;
    return people.find((l) => l !== me.login && stats[l]) || people.find((l) => l !== me.login) || people[0];
  }
  const statsPeople = () => [...connections.filter((c) => c.mutual).map((c) => c.login), me.login];

  // Twitch's public numbers for whoever's showing, at most once a minute.
  const fetchingPublic = {};
  async function refreshPublic(login) {
    if (DEMO || DEV || fetchingPublic[login] || Date.now() - (publicStats[login]?.at || 0) < SAMPLE_MS) return;
    const id = login === me.login ? me.id : ids[login];
    if (!id) return;
    fetchingPublic[login] = true;
    try {
      publicStats[login] = await fetchPublic(id);
      if (view === "stats") render();
    } catch {}
    fetchingPublic[login] = false;
  }
  setInterval(() => {
    if (view === "stats" && me) render(); // keeps the clocks moving
  }, 30000);

  const num = (n) => (n == null ? "–" : Number(n).toLocaleString());
  function untilWhen(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (!iso || Number.isNaN(ms)) return "";
    if (ms <= 0) return "now";
    const m = Math.round(ms / 60000);
    if (m < 60) return `in ${m} min`;
    const h = Math.round(m / 60);
    return h < 48 ? `in ${h} h` : `in ${Math.round(h / 24)} days`;
  }
  function uptime(iso) {
    const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
    return Number.isNaN(m) ? "" : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  }

  function statsPanel() {
    const panel = el("div", "panel stats");
    const who = statsWho();
    statsDraft.who = who;
    refreshPublic(who);
    const shared = stats[who];
    const pub = publicStats[who] || {};
    // Newest of what Twitch says now and what their panel last sent.
    const now = { ...(shared?.now || {}), ...(pub.at && pub.at > (shared?.now?.at || 0) ? pub : {}) };

    // Everyone you can see, to switch between.
    const people = el("div", "stats__people");
    for (const login of statsPeople()) {
      const chip = personChip(login, `ask__person${login === who ? " ask__person--on" : ""}`);
      if (login === me.login) chip.querySelector(".ask__name").textContent = "You";
      chip.addEventListener("click", () => {
        statsDraft.who = login;
        render();
      });
      people.append(chip);
    }
    panel.append(people);

    // Now.
    const head = el("div", "stats__now");
    head.append(el("span", `stats__live${now.live ? " stats__live--on" : ""}`, now.live ? "LIVE" : "Offline"));
    if (now.live) head.append(el("span", "stats__big", `${num(now.viewers)} watching`), el("span", "stats__muted", uptime(now.startedAt)));
    panel.append(head);
    if (now.live && (now.game || now.title)) panel.append(el("div", "stats__title", [now.game, now.title].filter(Boolean).join(" · ")));

    const grid = (title, rows) => {
      const shown = rows.filter(([, v]) => v !== "" && v != null);
      if (!shown.length) return;
      panel.append(el("div", "ask__label", title));
      const box = el("div", "stats__grid");
      for (const [label, value, link] of shown) {
        const cell = el("div", "stats__cell");
        const v = link ? el("a", "stats__value", value) : el("div", "stats__value", value);
        if (link) {
          v.href = link;
          v.target = "_blank";
          v.rel = "noopener";
        }
        cell.append(v, el("div", "stats__label", label));
        box.append(cell);
      }
      panel.append(box);
    };

    const st = shared?.stream;
    if (st) {
      grid("This stream", [
        ["Subs", num(st.subs)],
        ["Gift subs", num(st.gifts)],
        ["Top gifter", st.topGifter ? `${st.topGifter.who} (${st.topGifter.n})` : "–"],
        ["Bits", num(st.bits)],
        ["New followers", num(st.follows)],
        ["Average viewers", num(st.avg)],
        ["Highest viewers", num(st.peak)],
      ]);
    }
    if (shared) {
      grid("Records", [
        ["Highest this week", num(shared.week?.peak)],
        ["Average this week", num(shared.week?.avg)],
        ["Highest this month", num(shared.month?.peak)],
        ["Average this month", num(shared.month?.avg)],
        ["Subs this month", num(shared.month?.subs)],
        ["Active subs", now.subsTotal == null ? "" : num(now.subsTotal)],
      ]);
      grid("Raids", [
        ["Last raided", shared.lastRaidOut ? `${shared.lastRaidOut.who} (${num(shared.lastRaidOut.viewers)})` : "–"],
        ["Last raided by", shared.lastRaidIn ? `${shared.lastRaidIn.who} (${num(shared.lastRaidIn.viewers)})` : "–"],
      ]);
    }
    const [nextAt, nextTitle] = (now.nextStream || "").split("|");
    grid("Channel", [
      ["Followers", now.followers == null ? "" : num(now.followers)],
      ["Chat mode", now.chatMode || ""],
      ["Next ad", now.live && now.adNext ? untilWhen(now.adNext) : ""],
      ["Hype train", shared?.hype ? `Level ${shared.hype.level} (${num(shared.hype.progress)} / ${num(shared.hype.goal)})` : ""],
      ["Next stream", nextAt ? `${untilWhen(nextAt)}${nextTitle ? `: ${nextTitle}` : ""}` : ""],
      ["Latest clip", now.clip?.url ? now.clip.title || "Watch" : "", now.clip?.url],
    ]);

    if (who !== me.login && !shared) {
      panel.append(el("p", "panel__sub", `${who} hasn't switched on sharing, so this is what's public. Subs, raids, bits and viewer records need them to share from their OBS panel.`));
    } else if (shared?.now?.at) {
      panel.append(el("p", "panel__sub", `Their panel last reported ${ago(shared.now.at)}. Records start from when sharing was switched on.`));
    }
    if (who === me.login) panel.append(shareControl());
    return panel;
  }

  // Your own stats: the switch to record and share them.
  function shareControl() {
    const box = el("div", "stats__share");
    const granted = STATS_SCOPES.every((sc) => me.scopes?.includes(sc));
    if (EMBED) {
      box.append(el("p", "panel__sub", "Streamers switch on sharing from their OBS panel, which does the recording while they're live."));
      return box;
    }
    box.append(el("div", "panel__head", "Share my stream stats"));
    box.append(el("p", "panel__sub", "While this panel is open, it records your viewers, subs, gifts, bits, follows and raids, and shows them to the people you're connected with."));
    if (!granted && !DEMO && !DEV) {
      const b = el("button", "pill pill--on", "Turn on (sign in once more)");
      b.type = "button";
      b.addEventListener("click", () => {
        put("statsWanted", true);
        put("statsAfterSignin", true);
        signIn();
      });
      box.append(b);
      return box;
    }
    const b = el("button", `pill${statsOn ? "" : " pill--on"}`, statsOn ? "Stop sharing" : "Share with my connections");
    b.type = "button";
    b.addEventListener("click", () => {
      relay({ t: "statsShare", on: !statsOn });
      if (DEMO) {
        statsOn = !statsOn;
        render();
      }
    });
    box.append(b);
    return box;
  }

  // ===== Updates ===========================================================================
  // A newer version on GitHub: reload, unless something's being typed.

  async function checkForUpdate() {
    if (DEMO || !window.DOCK_VERSION) return;
    try {
      const v = (await (await fetch("version.txt", { cache: "no-store" })).text()).trim();
      if (!v || v === window.DOCK_VERSION) return;
      const typing = [...document.querySelectorAll("input[type=text]")].some((i) => i.value.trim() || i === document.activeElement);
      if (!typing) location.reload();
    } catch {}
  }

  // ===== Demo ==============================================================================
  // ?demo: a pretend relay, so the cards can be tried without signing in.

  function demoRelay(m) {
    const now = Date.now();
    const q = questions[m.id];
    if (m.t === "ask") gotQuestion({ id: `d${now}`, from: me.login, to: m.to, text: m.text, at: now, answer: null, dismissed: 0, seenAt: 0 });
    else if (m.t === "answer" && q) gotQuestion({ ...q, answer: { code: m.code, text: m.text, at: now } });
    else if (m.t === "dismiss" && q) gotQuestion({ ...q, dismissed: now });
    else if (m.t === "seen" && q) gotQuestion({ ...q, seenAt: now });
    else if (m.t === "connect") gotState({ connections: [...connections, { login: m.login, mutual: requests.includes(m.login), online: false }], requests: requests.filter((l) => l !== m.login), tags, questions: Object.values(questions) });
    else if (m.t === "disconnect") gotState({ connections: connections.filter((c) => c.login !== m.login), requests, tags, questions: Object.values(questions) });
    else if (m.t === "flash") {
      gotFlash({ id: `f${now}`, kind: m.kind, from: "tallglassofwasps", to: me.login, text: m.text, at: now });
      gotFlashed({ kind: m.kind, reached: 1 });
    } else if (m.t === "say") gotMessage({ id: `d${now}`, owner: m.owner, from: me.login, text: m.text, at: now });
    else if (m.t === "tag") {
      const next = { ...tags, [m.tag]: [...new Set([...(tags[m.tag] || []), m.login])].filter((l) => m.on || l !== m.login) };
      if (!next[m.tag].length) delete next[m.tag];
      gotState({ connections, requests, tags: next, questions: Object.values(questions) });
    }
    return true;
  }

  function startDemo() {
    me = { login: "you" };
    const now = Date.now();
    gotState({
      connections: [{ login: "tallglassofwasps", mutual: true, online: true }, { login: "techbuddy", mutual: true, online: false }],
      requests: ["somemod"],
      tags: { Mods: ["tallglassofwasps"], Tech: ["techbuddy"] },
      rooms: [{ owner: "you", tag: "Mods", members: [{ login: "you", online: true }, { login: "tallglassofwasps", online: true }] }],
      statsOn: true,
      stats: {
        tallglassofwasps: {
          now: { live: true, viewers: 212, startedAt: new Date(now - 7380000).toISOString(), game: "Baldur's Gate 3", title: "Act 3 tonight", followers: 18432, subsTotal: 311, adNext: new Date(now - 7380000 + 7380000 + 840000).toISOString(), chatMode: "Followers only", nextStream: `${new Date(now + 90000000).toISOString()}|Friday chill`, clip: { title: "The barrel incident", url: "https://clips.twitch.tv/demo", at: "" }, at: now - 20000 },
          stream: { subs: 14, gifts: 10, topGifter: { who: "TallGlassOfWasps", n: 5 }, bits: 1250, follows: 37, avg: 188, peak: 241 },
          week: { peak: 302, avg: 176 }, month: { peak: 340, avg: 169, subs: 96 },
          lastRaidOut: { who: "OH_MANNY", viewers: 198, at: now - 90000000 }, lastRaidIn: { who: "dampeyes", viewers: 41, at: now - 3000000 },
          hype: { level: 2, progress: 640, goal: 1200, ends: "" },
        },
      },
      chat: { you: [{ id: "c1", owner: "you", from: "tallglassofwasps", text: "Raid target after this game?", at: now - 300000 }, { id: "c2", owner: "you", from: "tallglassofwasps", text: "@you also the poll is ready", at: now - 60000 }] },
      questions: [
        { id: "demo01", from: "tallglassofwasps", to: "you", text: "Can I clip that last play for TikTok?", at: now, answer: null, dismissed: 0, seenAt: 0 },
        { id: "demo02", from: "you", to: "tallglassofwasps", text: "Can you mod tonight?", at: now - 60000, answer: { code: "y", text: "", at: now }, dismissed: 0, seenAt: 0 },
        { id: "demo03", from: "tallglassofwasps", to: "you", text: "Is the raid still on?", at: now - 120000, answer: { code: "s", text: "", at: now - 90000 }, dismissed: 0, seenAt: now - 30000 },
      ],
    });
    setStatus("Demo", "wait");
  }

  // ===== Start =============================================================================

  peopleBtn.addEventListener("click", () => show("people"));
  chatBtn.addEventListener("click", () => show("chat", chatRoom()));
  statsBtn.addEventListener("click", () => show("stats", statsWho()));
  quickAsk.addEventListener("submit", (e) => {
    e.preventDefault();
    const question = clean(quickText.value);
    if (!question || !relay({ t: "ask", to: quickTo.value, text: question, options: STANDARD })) return;
    quickText.value = "";
    quickText.placeholder = "Sent ✓";
    setTimeout(() => (quickText.placeholder = "Ask…"), 2500);
  });
  askFull.addEventListener("click", () => show("ask", quickTo.value));
  quickTo.addEventListener("change", drawQuick);
  // The dock being resized can change it between one row and full.
  addEventListener("resize", () => me && render());
  askBtn.addEventListener("click", () => {
    if (short()) return show("ask");
    put("askOpen", true);
    view = "cards";
    render();
    document.querySelector('[data-key="ask"]')?.focus();
  });

  let started = false;
  async function start() {
    if (POPOUT) document.body.classList.add("popout");
    if (EMBED) document.body.classList.add("embed");
    if (DEMO) {
      askBtn.hidden = peopleBtn.hidden = false;
      return startDemo();
    }
    if (!TWITCH_CLIENT_ID) return showMessage("Not set up yet", "Put the Twitch app's Client ID in config.js.");
    let error = "";
    if (DEV) {
      // ?expires=<minutes> pretends the sign-in runs out then (testing the warning).
      me = { login: DEV.toLowerCase(), expiresAt: params.has("expires") ? Date.now() + Number(params.get("expires")) * 60000 : 0 };
    } else {
      error = takeTokenFromAddress();
      try {
        me = await validate();
      } catch {
        setTimeout(start, 15000);
        return showMessage("Can't reach Twitch", "Trying again in a few seconds.");
      }
    }
    if (!me) return showSignedOut(error ? `Twitch said: ${error}` : "");
    askBtn.hidden = peopleBtn.hidden = false;
    shareSignin(get("token"));
    setStatus("Connecting…", "wait");
    render();
    connect();
    if (started) return;
    started = true;
    // Twitch asks apps to re-check the sign-in every hour.
    setInterval(async () => {
      if (!me || DEV) return;
      const now = await validate().catch(() => me);
      if (!now) return showSignedOut("Your Twitch sign-in ran out. Sign in again.");
      me.expiresAt = now.expiresAt;
      render();
    }, 60 * 60 * 1000);
    setInterval(checkForUpdate, UPDATE_CHECK_MS);
  }

  start();
})();

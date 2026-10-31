// Ask the Streamer, as an OBS dock. The streamer adds this page as a Custom
// Browser Dock in OBS; questions from Twitch Space users show here as cards,
// and the answer goes back as a whisper that Twitch Space shows as a card.
//
// It speaks the same whispers as Twitch Space (askstreamer.js):
//   question  "❓ Can I clip that? [MTT ?k3j9x2]"
//   answer    "✅ Yes (re: "Can I clip that?") [MTT !k3j9x2 y]"
//   reply     "💬 Sure, go ahead [MTT !k3j9x2 c]"
//
// Twitch Space works the whisper window by hand; a page in OBS can't, so this
// signs in to Twitch's own API instead:
//   receiving: an EventSub WebSocket subscribed to user.whisper.message, so a
//              question shows the moment it's sent (only while OBS is open:
//              Twitch doesn't hand over whispers from before)
//   sending:   POST helix/whispers (Twitch needs a verified phone number on
//              the streamer's account for this)
//
// Connections: like Twitch Space, only people on your list can put a card
// here, at most 3 unanswered each. Who sent a whisper comes from Twitch, not
// from the message text.
//
// Saved in this page's localStorage (OBS keeps it between restarts):
//   "token"    the Twitch sign-in
//   "trusted"  [logins]                                  your connections
//   "inbox"    { id: { from, name, text, at, done, error } } (kept a week)
//   "ids"      { login: user id }                        so answers needn't look them up
//
// Open with ?demo to try the cards without signing in.

(() => {
  const SCOPES = "user:read:whispers user:manage:whispers";
  const HELIX = "https://api.twitch.tv/helix";
  const EVENTSUB_WS = "wss://eventsub.wss.twitch.tv/ws";
  const MAX_LEN = 200;
  const MAX_OPEN_PER_PERSON = 3;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const TAG_RE = /\[MTT ([?!])([a-z0-9]{4,10})(?: ([ynmsotc]))?\]/;
  const DEMO = new URLSearchParams(location.search).has("demo");

  const svg = (paths, size = 18) => `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true">${paths}</svg>`;
  const LINE = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';
  // Same answers, emoji and icons as Twitch Space.
  const ANSWERS = {
    y: { label: "Yes", emoji: "✅", icon: `<path d="M4 10.5l4 4 8-9" ${LINE} stroke-width="2.4"/>` },
    n: { label: "No", emoji: "❌", icon: `<path d="M5 5l10 10M15 5L5 15" ${LINE} stroke-width="2.4"/>` },
    m: { label: "Maybe", emoji: "🤔", icon: `<path d="M7 7.2a3 3 0 1 1 4.2 2.8c-.8.4-1.2 1-1.2 1.8v.7" ${LINE} stroke-width="2.2"/><circle cx="10" cy="15.6" r="1.3" fill="currentColor"/>` },
    s: { label: "Soon", emoji: "⏳", icon: `<path d="M5 2.5h10M5 17.5h10M6 2.5c0 4 8 4.5 8 7.5s-8 3.5-8 7.5M14 2.5c0 4-8 4.5-8 7.5s8 3.5 8 7.5" ${LINE} stroke-width="1.8"/>` },
    o: { label: "OK", emoji: "👍", icon: '<path d="M7 9l3-6c1.2 0 2 .8 2 2v3h3.5a1.5 1.5 0 0 1 1.5 1.8l-1.1 6A1.5 1.5 0 0 1 14.4 17H7zM3 9h3v8H3z" fill="currentColor"/>' },
    t: { label: "Thank you", emoji: "💜", icon: '<path d="M10 17s-6.5-4-6.5-8.6A3.6 3.6 0 0 1 10 6.2a3.6 3.6 0 0 1 6.5 2.2C16.5 13 10 17 10 17z" fill="currentColor"/>' },
    c: { label: "Replied", emoji: "💬" }, // a typed reply
  };

  const main = document.getElementById("main");
  const statusEl = document.getElementById("status");
  const peopleBtn = document.getElementById("peopleBtn");

  let me = null; // { login, id }
  let showPeople = false;
  const drafts = {}; // question id -> reply being typed (kept if the cards redraw)

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

  let trusted = get("trusted", []);
  let inbox = get("inbox", {});
  const ids = get("ids", {});

  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const cleanText = (s) => s.replace(/\[MTT/gi, "[mtt").trim(); // nobody can fake a tag
  const newId = () => Math.random().toString(36).slice(2, 10);

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = `bar__status${kind ? ` bar__status--${kind}` : ""}`;
  }

  // ===== Signing in ========================================================================
  // Twitch's implicit sign-in: off to Twitch, back here with the token after "#".

  function signIn() {
    const state = newId();
    put("signinState", state);
    const q = new URLSearchParams({
      response_type: "token",
      client_id: TWITCH_CLIENT_ID,
      redirect_uri: location.origin + location.pathname,
      scope: SCOPES,
      state,
    });
    location.href = `https://id.twitch.tv/oauth2/authorize?${q}`;
  }

  // Back from Twitch: keep the token and clear it out of the address.
  function takeTokenFromAddress() {
    if (!location.hash.includes("access_token") && !location.search.includes("error")) return;
    const h = new URLSearchParams(location.hash.slice(1));
    const s = new URLSearchParams(location.search);
    const state = h.get("state") || s.get("state");
    if (state && state === get("signinState")) {
      if (h.get("access_token")) put("token", h.get("access_token"));
    }
    localStorage.removeItem("signinState");
    history.replaceState(null, "", location.pathname);
    if (s.get("error")) return s.get("error_description") || s.get("error");
  }

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
    return { login: j.login, id: j.user_id };
  }

  function signOut() {
    const token = get("token");
    localStorage.removeItem("token");
    if (token) {
      fetch("https://id.twitch.tv/oauth2/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: TWITCH_CLIENT_ID, token }),
      }).catch(() => {});
    }
    location.reload();
  }

  // ===== Twitch API ========================================================================

  async function helix(path, options = {}) {
    const r = await fetch(HELIX + path, {
      ...options,
      headers: {
        Authorization: `Bearer ${get("token")}`,
        "Client-Id": TWITCH_CLIENT_ID,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    if (r.status === 401) {
      localStorage.removeItem("token");
      showSignedOut("Your Twitch sign-in ran out. Sign in again.");
      throw new Error("signed out");
    }
    return r;
  }

  async function lookUp(login) {
    if (ids[login]) return { login, id: ids[login] };
    const r = await helix(`/users?login=${encodeURIComponent(login)}`);
    const u = (await r.json()).data?.[0];
    if (!u) return null;
    ids[u.login] = u.id;
    put("ids", ids);
    return { login: u.login, id: u.id, name: u.display_name };
  }

  // Send one whisper. Returns "" once sent, or why not.
  async function whisper(to, text) {
    if (DEMO) return "";
    try {
      const user = await lookUp(to);
      if (!user) return `couldn't find ${to} on Twitch`;
      const r = await helix(`/whispers?from_user_id=${me.id}&to_user_id=${user.id}`, {
        method: "POST",
        body: JSON.stringify({ message: text }),
      });
      if (r.status === 204) return "";
      const why = (await r.json().catch(() => ({}))).message || `Twitch said ${r.status}`;
      if (/phone/i.test(why)) return "Twitch needs a verified phone number on your account to send whispers";
      if (r.status === 429) return "Twitch says too many whispers right now, try again in a minute";
      return why;
    } catch (e) {
      return e.message === "signed out" ? "signed out" : "couldn't reach Twitch";
    }
  }

  // ===== Receiving: EventSub WebSocket =====================================================

  let socket = null;
  let watchdog = 0;
  let retryMs = 1000;

  function connect(url = EVENTSUB_WS, isReconnect = false) {
    const ws = new WebSocket(url);
    let keepaliveMs = 10000;
    const feed = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ws.close(), keepaliveMs + 10000); // Twitch went quiet
    };

    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      const type = msg.metadata?.message_type;
      feed();
      if (type === "session_welcome") {
        keepaliveMs = (msg.payload.session.keepalive_timeout_seconds || 10) * 1000;
        feed();
        const old = socket;
        socket = ws;
        if (isReconnect && old) old.close(); // subscriptions carry over
        else await subscribe(msg.payload.session.id);
        retryMs = 1000;
      } else if (type === "session_reconnect") {
        connect(msg.payload.session.reconnect_url, true);
      } else if (type === "notification" && msg.metadata.subscription_type === "user.whisper.message") {
        const ev = msg.payload.event;
        handleWhisper(ev.whisper?.text || "", ev.from_user_login, ev.from_user_name, ev.from_user_id);
      } else if (type === "revocation") {
        setStatus("Twitch stopped sending whispers", "bad");
      }
    };

    ws.onclose = () => {
      if (ws !== socket) return; // an old one being swapped out
      socket = null;
      clearTimeout(watchdog);
      setStatus("Reconnecting…", "wait");
      setTimeout(() => connect(), retryMs);
      retryMs = Math.min(retryMs * 2, 60000);
    };
    if (!socket) socket = ws;
  }

  async function subscribe(sessionId) {
    try {
      const r = await helix("/eventsub/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          type: "user.whisper.message",
          version: "1",
          condition: { user_id: me.id },
          transport: { method: "websocket", session_id: sessionId },
        }),
      });
      if (r.ok || r.status === 409) setStatus("Listening", "ok");
      else setStatus(`Couldn't listen: ${(await r.json().catch(() => ({}))).message || r.status}`, "bad");
    } catch {}
  }

  function handleWhisper(body, from, name, fromId) {
    const m = body.match(TAG_RE);
    from = (from || "").toLowerCase();
    if (!m || m[1] !== "?" || !from || from === me?.login) return; // only questions to you
    if (fromId && !ids[from]) {
      ids[from] = fromId;
      put("ids", ids);
    }
    const id = m[2];
    if (!trusted.includes(from) || inbox[id]) return; // not on your list (stays a normal whisper), or already have it
    const open = Object.values(inbox).filter((q) => q.from === from && !q.done).length;
    if (open >= MAX_OPEN_PER_PERSON) return;
    const text = body.replace(TAG_RE, "").trim().replace(/^❓\s*/, "");
    inbox[id] = { from, name: name || from, text, at: Date.now() };
    saveInbox();
    render();
    flash();
  }

  function saveInbox() {
    for (const [k, q] of Object.entries(inbox)) if (Date.now() - q.at > 7 * DAY_MS) delete inbox[k];
    put("inbox", inbox);
  }

  // A new question: the dock's edge glows for a few seconds.
  function flash() {
    document.body.classList.remove("flash");
    void document.body.offsetWidth;
    document.body.classList.add("flash");
  }

  // ===== Answering =========================================================================

  async function answer(id, code, reply) {
    const q = inbox[id];
    if (!q || q.sending) return;
    const a = ANSWERS[code];
    const text = code === "c"
      ? `${a.emoji} ${reply} [MTT !${id} c]`
      : `${a.emoji} ${a.label} (re: "${clip(q.text, 60)}") [MTT !${id} ${code}]`;
    q.sending = true;
    q.error = null;
    render();
    const why = await whisper(q.from, text);
    delete q.sending;
    if (why) {
      q.error = `Didn't send: ${why}.`;
    } else {
      q.done = true;
      delete drafts[id];
    }
    saveInbox();
    render();
  }

  function dismiss(id) {
    if (!inbox[id]) return;
    inbox[id].done = true;
    delete drafts[id];
    saveInbox();
    render();
  }

  // ===== Drawing ===========================================================================

  function render() {
    if (!me) return;
    main.replaceChildren(showPeople ? peoplePanel() : questionList());
    peopleBtn.textContent = showPeople ? "Done" : `Connections (${trusted.length})`;
  }

  function questionList() {
    const wrap = el("div", "cards");
    const open = Object.keys(inbox).filter((id) => !inbox[id].done).sort((a, b) => inbox[a].at - inbox[b].at);
    if (!open.length) {
      const empty = el("div", "empty");
      empty.append(
        el("div", "empty__head", "No questions right now"),
        el("div", "empty__sub", trusted.length
          ? "Questions from your connections show up here."
          : "Add the people who can ask you under Connections."),
      );
      wrap.append(empty);
    }
    for (const id of open) wrap.append(questionCard(id));
    return wrap;
  }

  function questionCard(id) {
    const q = inbox[id];
    const card = el("div", "qcard");
    card.setAttribute("role", "alertdialog");
    card.append(el("div", "qcard__head", `${q.name} asks`), el("div", "qcard__text", q.text));
    if (q.error) card.append(el("div", "qcard__error", q.error));
    const buttons = el("div", "qcard__answers");
    for (const [code, a] of Object.entries(ANSWERS)) {
      if (code === "c") continue;
      const b = el("button", `qcard__answer answer--${code}`);
      b.type = "button";
      b.disabled = !!q.sending;
      b.innerHTML = svg(a.icon);
      b.append(el("span", null, a.label));
      b.addEventListener("click", () => answer(id, code));
      buttons.append(b);
    }
    const own = el("form", "qcard__own");
    const input = el("input");
    input.type = "text";
    input.maxLength = MAX_LEN;
    input.placeholder = "Or type your own reply";
    input.autocomplete = "off";
    input.value = drafts[id] || "";
    input.addEventListener("input", () => (drafts[id] = input.value));
    const send = el("button", null, q.sending ? "Sending…" : "Send");
    send.type = "submit";
    send.disabled = !!q.sending;
    own.append(input, send);
    own.addEventListener("submit", (e) => {
      e.preventDefault();
      const reply = cleanText(input.value);
      if (reply) answer(id, "c", reply);
    });
    const x = el("button", "qcard__dismiss", "Dismiss without answering");
    x.type = "button";
    x.addEventListener("click", () => dismiss(id));
    card.append(buttons, own, x);
    return card;
  }

  // Connections: who can ask you. Twitch Space's list must have you on it too.
  function peoplePanel() {
    const panel = el("div", "people");
    panel.append(
      el("div", "people__head", "Who can ask you"),
      el("p", "people__sub", "Only questions from people here show up. They need you on their Twitch Space connections too."),
    );
    const form = el("form", "people__form");
    const input = el("input");
    input.type = "text";
    input.placeholder = "Twitch username";
    input.autocomplete = "off";
    input.spellcheck = false;
    const add = el("button", null, "Add");
    add.type = "submit";
    const note = el("p", "people__note");
    form.append(input, add);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const login = input.value.trim().replace(/^@/, "").toLowerCase();
      if (!/^[a-z0-9_]{2,25}$/.test(login)) return void (note.textContent = "That isn't a Twitch username.");
      if (trusted.includes(login)) return void (note.textContent = `${login} is already on your list.`);
      add.disabled = true;
      note.textContent = "";
      const user = DEMO ? { login } : await lookUp(login).catch(() => null);
      add.disabled = false;
      if (!user) return void (note.textContent = `Couldn't find ${login} on Twitch.`);
      trusted = [...trusted, user.login];
      put("trusted", trusted);
      render();
    });
    panel.append(form, note);

    const list = el("div", "people__list");
    for (const login of trusted) {
      const row = el("div", "people__row");
      const x = el("button", "x", "×");
      x.type = "button";
      x.title = `Remove ${login}`;
      x.addEventListener("click", () => {
        trusted = trusted.filter((l) => l !== login);
        put("trusted", trusted);
        render();
      });
      row.append(el("span", "people__name", login), x);
      list.append(row);
    }
    if (!trusted.length) list.append(el("p", "people__sub", "Nobody yet."));
    panel.append(list);

    const out = el("button", "people__signout", `Sign out of ${me.login}`);
    out.type = "button";
    out.addEventListener("click", signOut);
    panel.append(out);
    return panel;
  }

  function showSignedOut(message) {
    me = null;
    peopleBtn.hidden = true;
    setStatus("");
    const box = el("div", "signin");
    box.append(el("div", "signin__head", "Questions from your connections, right in OBS"));
    if (message) box.append(el("p", "signin__error", message));
    const b = el("button", "signin__btn", "Sign in with Twitch");
    b.type = "button";
    b.addEventListener("click", signIn);
    box.append(b, el("p", "signin__sub", "Answers go back to them as whispers, from your account."));
    main.replaceChildren(box);
  }

  function showMessage(head, sub) {
    const box = el("div", "signin");
    box.append(el("div", "signin__head", head), el("p", "signin__sub", sub));
    main.replaceChildren(box);
  }

  // ===== Start =============================================================================

  peopleBtn.addEventListener("click", () => {
    showPeople = !showPeople;
    render();
  });

  // Someone else's tab/dock on this page changed the list or answered.
  addEventListener("storage", (e) => {
    if (e.key === "trusted") trusted = get("trusted", []);
    else if (e.key === "inbox") inbox = get("inbox", {});
    else return;
    render();
  });

  async function start() {
    if (DEMO) {
      me = { login: "you", id: "0" };
      if (!trusted.length) trusted = ["tallglassofwasps"];
      if (!Object.values(inbox).some((q) => !q.done)) {
        inbox["demo1"] = { from: "tallglassofwasps", name: "tallglassofwasps", text: "Can I clip that last play for TikTok?", at: Date.now() };
      }
      peopleBtn.hidden = false;
      setStatus("Demo", "wait");
      render();
      return;
    }
    if (!TWITCH_CLIENT_ID) {
      return showMessage("Not set up yet", "Put the Twitch app's Client ID in config.js.");
    }
    const error = takeTokenFromAddress();
    try {
      me = await validate();
    } catch {
      setTimeout(start, 15000);
      return showMessage("Can't reach Twitch", "Trying again in a few seconds.");
    }
    if (!me) return showSignedOut(error ? `Twitch said: ${error}` : "");
    ids[me.login] = me.id;
    peopleBtn.hidden = false;
    setStatus("Connecting…", "wait");
    render();
    connect();
    // Twitch asks apps to re-check the sign-in every hour.
    setInterval(async () => {
      if (me && !(await validate().catch(() => me))) showSignedOut("Your Twitch sign-in ran out. Sign in again.");
    }, 60 * 60 * 1000);
  }

  start();
})();

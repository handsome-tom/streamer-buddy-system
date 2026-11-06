// Custom chat for the chat dock (?livechat&ownchat): Twitch chat drawn by this page
// instead of Twitch's embedded chat, so it can do things of its own.
//
// Everything here is allowed to fail. dock.js shows Twitch's own chat the moment this
// file reports a problem through host.onFail, doesn't load, or goes quiet, so this
// file's one duty when something's wrong is to say so rather than limp along:
//   - it can't connect, or Twitch refuses a part it needs
//   - nothing's come from Twitch for 20 seconds (it pings every 10)
//   - the connection looks fine but messages stopped (compared with the anonymous chat
//     connection dock.js already keeps: see ircSaw)
//   - the sign-in ended or was withdrawn
//   - sending fails twice in a row, or the code here keeps hitting errors
//
// Messages are other people's words: they only ever go in as text, never as HTML.
//
// It has its own Twitch sign-in ("chatToken"), which can ban and delete. That one never
// goes to the relay; the relay only ever sees the ordinary sign-in.

(() => {
  const SCOPES = ["user:read:chat", "user:write:chat", "user:read:emotes", "moderator:manage:banned_users", "moderator:manage:chat_messages", "moderator:manage:automod"];
  const SILENCE_MS = 20 * 1000; // nothing at all from Twitch for this long: give up
  const KEEPALIVE_S = 10;
  const IRC_LAG_MS = 20 * 1000; // the other connection saw chat this long ago, this one didn't
  const MAX_LINES = 400;
  const MAX_LINES_PAUSED = 1500;
  const FLUSH_MS = 100; // busy chats draw in small batches
  const HOVER_HOLD_MS = 3000; // the chat holds still while the mouse is moving over it
  const ERRORS_ALLOWED = 3; // in a minute
  const RAIDER_MS = 15 * 60 * 1000; // how long raiders' lines are marked after a raid
  // Asked for at sign-in but not needed: Twitch's full list of who's in the chat, which
  // makes telling raiders from people already here exact even in big chats.
  const EXTRA_SCOPES = ["moderator:read:chatters", "moderator:read:followers"]; // followers: "Following since" on a name's card
  const CHATTERS_EVERY_MS = 2 * 60 * 1000;
  const TIMEOUTS = [["1m", 60], ["10m", 600], ["1h", 3600], ["24h", 86400]];
  // Twitch's chat commands don't run through the API, and could post as plain text, so
  // anything that looks like one is stopped here. Dots are how some people type them.
  const DOT_COMMANDS = /^\.(me|ban|unban|timeout|untimeout|clear|slow|slowoff|followers|followersoff|subscribers|subscribersoff|emoteonly|emoteonlyoff|uniquechat|uniquechatoff|mod|unmod|vip|unvip|raid|unraid|host|unhost|w|color|announce|shoutout|delete|commercial|marker|warn|pin|block|unblock)(\s|$)/i;

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function button(className, text, onClick, title) {
    const b = el("button", className, text);
    b.type = "button";
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }
  const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || "") ? c : "");

  // Little line icons for the message tools and the bookmark counter.
  const ICON = {
    bookmark: '<path d="M6 3.5h8a1 1 0 0 1 1 1v12l-5-3.2-5 3.2v-12a1 1 0 0 1 1-1z"/>',
    reply: '<path d="M8.5 5 4 9.5 8.5 14M4.5 9.5H12a4 4 0 0 1 4 4V15"/>',
    trash: '<path d="M4 6h12M8 6V4.5h4V6M6 6l.7 10h6.6L14 6M8.5 9v4.5M11.5 9v4.5"/>',
    ban: '<circle cx="10" cy="10" r="6.5"/><path d="M5.4 14.6l9.2-9.2"/>',
    clock: '<circle cx="10" cy="10" r="6.5"/><path d="M10 6.2V10l2.6 1.6"/>',
  };
  const icon = (name, size = 15) =>
    `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;
  function iconButton(className, name, onClick, title) {
    const b = button(className, "", onClick, title);
    b.innerHTML = icon(name);
    b.setAttribute("aria-label", title);
    return b;
  }

  function start(host) {
    const { me, channel, urls } = host;
    let stopped = false;
    let failed = false;
    let ready = false;
    let lastOk = Date.now();
    let lastTick = Date.now();
    let broadcasterId = host.channelId || "";
    let isMod = channel === me.login;
    let socket = null;
    let moving = false; // Twitch asked us to move to a new connection, and it's on its way
    let retryTimer = 0;
    let everConnected = false;
    let lostAt = 0;
    let sendFailures = 0;
    let errors = [];
    let replyTo = null;
    const timers = [];

    // ----- What's on screen ------------------------------------------------------------
    const root = el("div", `oc${isMod ? " oc--mod" : ""}`);
    const bar = el("div", "oc-bar");
    const statusEl = el("span", "oc-status oc-status--wait", "Connecting…");
    const twitchBtn = button("oc-link", "Use Twitch chat", () => host.onChoose?.(), "Switch to Twitch's own chat");
    const marksBtn = button("oc-marks", "", () => showMark(), "Go to your bookmarks (click again for the next)");
    marksBtn.hidden = true;
    bar.append(statusEl, marksBtn, twitchBtn);
    const heldEl = el("div", "oc-held");
    heldEl.hidden = true;
    const listWrap = el("div", "oc-listwrap");
    const list = el("div", "oc-list");
    const moreBtn = button("oc-more", "More messages below", () => {
      follow = true;
      holdUntil = 0;
      toBottom();
    });
    moreBtn.hidden = true;
    const card = el("div", "oc-card");
    card.hidden = true;
    listWrap.append(list, moreBtn, card);
    const noteEl = el("div", "oc-note");
    noteEl.hidden = true;
    const replyEl = el("div", "oc-replying");
    replyEl.hidden = true;
    const picker = el("div", "oc-picker");
    picker.hidden = true;
    const composer = el("form", "oc-send");
    const input = el("input", "oc-input");
    Object.assign(input, { type: "text", maxLength: 500, placeholder: "Send a message", autocomplete: "off", spellcheck: true, name: "sbs-chat-message" });
    input.setAttribute("data-1p-ignore", "");
    input.setAttribute("data-lpignore", "true");
    const pickBtn = button("oc-emotebtn", "☺", () => togglePicker(), "Emotes");
    composer.append(input, pickBtn);
    root.append(bar, heldEl, listWrap, noteEl, replyEl, picker, composer);
    host.box.append(root);

    function setStatus(text, kind) {
      statusEl.textContent = text;
      statusEl.className = `oc-status oc-status--${kind}`;
    }

    let noteTimer = 0;
    function note(text, ms = 6000) {
      noteEl.textContent = text;
      noteEl.hidden = false;
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => (noteEl.hidden = true), ms);
    }

    // ----- Failing over ----------------------------------------------------------------
    function fail(reason) {
      if (failed || stopped) return;
      failed = true;
      try {
        host.onFail(reason);
      } catch {}
    }

    // One odd message shouldn't lose the chat, but repeated errors mean the code here is
    // wrong about something, so hand over.
    function codeError(err) {
      console.warn("Custom chat:", err);
      const now = Date.now();
      errors = errors.filter((t) => now - t < 60000);
      errors.push(now);
      if (errors.length >= ERRORS_ALLOWED) fail("it kept hitting errors");
    }
    const onPageError = (e) => {
      if (String(e.filename || "").includes("ownchat.js")) codeError(e.message);
    };
    addEventListener("error", onPageError);

    // ----- Talking to Twitch -----------------------------------------------------------
    async function api(path, options = {}) {
      const r = await fetch(urls.helix + path, {
        ...options,
        headers: { Authorization: `Bearer ${host.token()}`, "Client-Id": host.clientId, ...(options.body ? { "Content-Type": "application/json" } : {}) },
      });
      if (r.status === 401) fail("the Twitch sign-in ended");
      return r;
    }

    async function why(r, fallback) {
      try {
        return (await r.json()).message || fallback;
      } catch {
        return fallback;
      }
    }

    // ----- Connection ------------------------------------------------------------------
    function connect(url, swapping) {
      if (stopped) return;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        return fail("it couldn't reach Twitch");
      }
      const old = socket;
      if (swapping) moving = true;
      else socket = ws;
      ws.onmessage = (e) => {
        if (stopped) return;
        let m;
        try {
          m = JSON.parse(e.data);
        } catch (err) {
          return codeError(err);
        }
        const type = m.metadata?.message_type;
        if (type === "session_welcome") {
          if (swapping) {
            // Twitch moved us: the new connection already has everything, so drop the old.
            socket = ws;
            swapping = false;
            moving = false;
            lastOk = Date.now();
            if (old) {
              old.onclose = null;
              old.close();
            }
          } else {
            lastOk = Date.now();
            subscribe(m.payload.session.id);
          }
          return;
        }
        if (ws !== socket) return;
        lastOk = Date.now();
        if (type === "session_reconnect") connect(m.payload.session.reconnect_url, true);
        else if (type === "revocation") fail("Twitch withdrew permission");
        else if (type === "notification") {
          try {
            gotEvent(m.payload.subscription.type, m.payload.event);
          } catch (err) {
            codeError(err);
          }
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        if (swapping) moving = false; // the new connection failed before it started
        else if (ws !== socket || moving) return; // the old one can close before the new one says hello
        setStatus("Reconnecting…", "retry");
        lostAt = lostAt || Date.now();
        clearTimeout(retryTimer);
        // The watchdog below decides when this has gone on too long.
        retryTimer = setTimeout(() => connect(`${urls.eventsub}?keepalive_timeout_seconds=${KEEPALIVE_S}`), 2000);
      };
    }

    async function subscribe(session) {
      const asMe = { broadcaster_user_id: broadcasterId, user_id: me.id };
      const asMod = { broadcaster_user_id: broadcasterId, moderator_user_id: me.id };
      const chat = ["channel.chat.message", "channel.chat.notification", "channel.chat.clear", "channel.chat.clear_user_messages", "channel.chat.message_delete"];
      const add = async (type, version, condition) => {
        const r = await api("/eventsub/subscriptions", { method: "POST", body: JSON.stringify({ type, version, condition, transport: { method: "websocket", session_id: session } }) });
        return r.ok || r.status === 409; // 409: already there
      };
      try {
        const got = await Promise.all(chat.map((type) => add(type, "1", asMe)));
        if (got.includes(false)) return fail("Twitch refused a chat connection");
        // AutoMod holds are the part that could go missing silently, so on your own
        // channel not getting them means this chat isn't safe to rely on. On someone
        // else's, being refused just means you aren't a mod there.
        const mod = await Promise.all(["automod.message.hold", "automod.message.update"].map((type) => add(type, "2", asMod)));
        if (mod.includes(false)) {
          if (channel === me.login) return fail("Twitch refused AutoMod holds");
          isMod = false;
        } else isMod = true;
      } catch (err) {
        return fail("it couldn't reach Twitch");
      }
      if (stopped || failed) return;
      if (everConnected && lostAt) {
        const secs = Math.round((Date.now() - lostAt) / 1000);
        addSystem(`Reconnected. Messages from the last ${Math.max(1, secs)} seconds may be missing.`);
      }
      lostAt = 0;
      everConnected = true;
      ready = true;
      root.classList.toggle("oc--mod", isMod); // the mod icons before names
      setStatus(isMod ? "Custom chat" : "Custom chat (not a mod here)", "ok");
    }

    // Is this connection really getting chat? dock.js keeps a separate anonymous
    // connection, and tells us who it saw talk. If several people's lines show there and
    // nothing's arrived here, messages have stopped even though the connection looks fine.
    // It takes a few people, because Twitch can hide some people (like anyone you've
    // blocked) from this connection on purpose.
    const ircWaiting = []; // { login, at }
    const seenHere = new Map(); // login -> when this connection saw them
    let lastHere = Date.now();
    function ircSaw(login) {
      if (!ready) return;
      const at = seenHere.get(login);
      if (at && Date.now() - at < 60000) {
        seenHere.delete(login);
        return;
      }
      ircWaiting.push({ login, at: Date.now() });
    }
    function sawHere(login) {
      lastHere = Date.now();
      const i = ircWaiting.findIndex((w) => w.login === login);
      if (i >= 0) ircWaiting.splice(i, 1);
      else {
        seenHere.set(login, Date.now());
        if (seenHere.size > 5000) seenHere.clear();
      }
    }

    timers.push(setInterval(() => {
      const now = Date.now();
      // A long gap between ticks means the computer slept; that isn't chat failing.
      if (now - lastTick > 20000) {
        lastOk = now;
        lastHere = now;
        ircWaiting.length = 0;
      }
      lastTick = now;
      if (now - lastOk > SILENCE_MS) return fail("the connection to Twitch stopped");
      while (ircWaiting.length && now - ircWaiting[0].at > 120000) ircWaiting.shift();
      const late = ircWaiting.filter((w) => now - w.at > IRC_LAG_MS);
      if (late.length >= 3 && new Set(late.map((w) => w.login)).size >= 2 && now - lastHere > IRC_LAG_MS) fail("messages stopped arriving");
    }, 2000));

    // Twitch asks apps to check their sign-in hourly.
    timers.push(setInterval(async () => {
      try {
        const r = await fetch(urls.validate, { headers: { Authorization: `OAuth ${host.token()}` } });
        if (r.status === 401) fail("the Twitch sign-in ended");
      } catch {}
    }, 60 * 60 * 1000));

    // ----- Emotes and badges -----------------------------------------------------------
    const badges = new Map(); // "set/version" -> { url, title }
    const otherEmotes = new Map(); // name -> picture (7TV, BTTV, FFZ)
    const myEmotes = new Map(); // name -> picture (what you can send)

    const twitchEmoteUrl = (e) => `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(e.id)}/${(e.format || []).includes("animated") ? "animated" : "static"}/dark/1.0`;

    async function loadBadges() {
      for (const path of ["/chat/badges/global", `/chat/badges?broadcaster_id=${broadcasterId}`]) {
        try {
          const j = await (await api(path)).json();
          for (const set of j.data || []) for (const v of set.versions || []) badges.set(`${set.set_id}/${v.id}`, { url: v.image_url_1x, title: v.title || set.set_id });
        } catch {}
      }
    }

    // Each one is a service of its own and any can be down: the emote then just reads as
    // its name, the same as it does without them.
    async function loadOtherEmotes() {
      if (!urls.otherEmotes) return;
      const add = (name, url) => name && otherEmotes.set(name, url);
      const seven = (set) => (set?.emotes || []).forEach((e) => add(e.name, `https://cdn.7tv.app/emote/${encodeURIComponent(e.id)}/1x.webp`));
      const bttv = (list) => (list || []).forEach((e) => add(e.code, `https://cdn.betterttv.net/emote/${encodeURIComponent(e.id)}/1x`));
      const ffz = (sets) => Object.values(sets || {}).forEach((s) => (s.emoticons || []).forEach((e) => add(e.name, `https://cdn.frankerfacez.com/emote/${encodeURIComponent(e.id)}/1`)));
      const load = (url, use) => fetch(url).then((r) => (r.ok ? r.json() : null)).then((j) => j && use(j)).catch(() => {});
      await Promise.all([
        load(`https://7tv.io/v3/emote-sets/global`, seven),
        load(`https://api.betterttv.net/3/cached/emotes/global`, bttv),
        load(`https://api.frankerfacez.com/v1/set/global`, (j) => ffz(j.sets)),
      ]);
      await Promise.all([
        load(`https://7tv.io/v3/users/twitch/${broadcasterId}`, (j) => seven(j.emote_set)),
        load(`https://api.betterttv.net/3/cached/users/twitch/${broadcasterId}`, (j) => {
          bttv(j.channelEmotes);
          bttv(j.sharedEmotes);
        }),
        load(`https://api.frankerfacez.com/v1/room/id/${broadcasterId}`, (j) => ffz(j.sets)),
      ]);
    }

    async function loadMyEmotes() {
      let after = "";
      try {
        for (let page = 0; page < 10; page++) {
          const j = await (await api(`/chat/emotes/user?user_id=${me.id}&broadcaster_id=${broadcasterId}${after ? `&after=${encodeURIComponent(after)}` : ""}`)).json();
          for (const e of j.data || []) myEmotes.set(e.name, twitchEmoteUrl(e));
          after = j.pagination?.cursor;
          if (!after) break;
        }
      } catch {}
    }

    function picture(url, name) {
      const img = el("img", "oc-emote");
      img.src = url;
      img.alt = name;
      img.title = name;
      img.loading = "lazy";
      return img;
    }

    // Plain words, with other services' emotes as pictures and web addresses as links.
    function drawWords(into, text) {
      let plain = "";
      const flush = () => {
        if (plain) into.append(plain);
        plain = "";
      };
      for (const part of String(text).split(/(\s+)/)) {
        if (otherEmotes.has(part)) {
          flush();
          into.append(picture(otherEmotes.get(part), part));
        } else if (/^https?:\/\/\S+$/i.test(part)) {
          flush();
          const a = el("a", "oc-url", part);
          a.href = part;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          into.append(a);
        } else plain += part;
      }
      flush();
    }

    function drawMessage(into, fragments, text) {
      const parts = fragments?.length ? fragments : [{ type: "text", text }];
      for (const f of parts) {
        if (f.type === "emote" && f.emote?.id) into.append(picture(twitchEmoteUrl(f.emote), f.text));
        else if (f.type === "mention") into.append(el("span", `oc-mention${f.mention?.user_login === me.login ? " oc-mention--me" : ""}`, f.text));
        else if (f.type === "cheermote") into.append(el("span", "oc-cheer", f.text));
        else drawWords(into, f.text);
      }
    }

    // ----- The list --------------------------------------------------------------------
    const byId = new Map(); // message id -> its line
    const known = new Set(); // Twitch can repeat itself, around reconnects especially
    let queue = [];
    let follow = true; // staying at the newest message
    let holdUntil = 0; // the mouse is over the chat
    let unseen = false;

    const held = () => !follow || Date.now() < holdUntil;
    function toBottom() {
      list.scrollTop = list.scrollHeight;
      unseen = false;
      moreBtn.hidden = true;
    }
    list.addEventListener("scroll", () => {
      const nearEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      if (nearEnd !== follow && (nearEnd || Date.now() >= holdUntil)) follow = nearEnd;
      if (follow && Date.now() >= holdUntil) {
        unseen = false;
        moreBtn.hidden = true;
      }
    }, { passive: true });
    list.addEventListener("mousemove", () => {
      holdUntil = Date.now() + HOVER_HOLD_MS;
    }, { passive: true });

    function flushLines() {
      if (queue.length) {
        const batch = document.createDocumentFragment();
        for (const line of queue) batch.append(line);
        list.append(batch);
        queue = [];
        unseen = true;
      }
      const limit = held() ? MAX_LINES_PAUSED : MAX_LINES;
      while (list.childElementCount > limit) {
        const first = list.firstElementChild;
        if (first.dataset.id) byId.delete(first.dataset.id);
        first.remove();
      }
      if (!held()) toBottom();
      else if (unseen) moreBtn.hidden = false;
    }

    // ----- Bookmarks and "where I was" -------------------------------------------------
    // Bookmark a message for later with its 🔖 button (shown on hover); again to take it
    // off. The 🔖 count in the bar goes back to them, newest first.
    //
    // One click on a message puts an orange line under it, right across the chat: where
    // you were. Clicking another message moves it; clicking the same one takes it away.
    const marks = []; // bookmarked message ids, oldest first
    let markShown = -1;
    let hereId = null;
    function drawMarks() {
      const n = marks.filter((id) => byId.has(id)).length;
      marksBtn.hidden = !n;
      marksBtn.innerHTML = `${icon("bookmark", 12)}<span>${n}</span>`;
    }
    function toggleMark(line) {
      const id = line?.dataset.id;
      if (!id) return;
      const at = marks.indexOf(id);
      if (at >= 0) marks.splice(at, 1);
      else marks.push(id);
      line.classList.toggle("oc-line--marked", at < 0);
      markShown = -1;
      drawMarks();
    }
    function showMark() {
      const live = marks.filter((id) => byId.has(id));
      if (!live.length) return drawMarks();
      markShown = (markShown + 1) % live.length;
      const line = byId.get(live[live.length - 1 - markShown]); // newest first
      follow = false;
      holdUntil = Date.now() + HOVER_HOLD_MS;
      list.scrollTop += line.getBoundingClientRect().top - list.getBoundingClientRect().top - 8;
      line.classList.remove("oc-line--flash");
      void line.offsetWidth;
      line.classList.add("oc-line--flash");
      if (unseen) moreBtn.hidden = false;
    }
    list.addEventListener("click", (e) => {
      const line = e.target.closest?.(".oc-line[data-id]");
      if (!line || e.target.closest("button, a, input, .oc-tools")) return;
      if (String(getSelection?.() || "")) return; // selecting text, not marking a place
      const old = hereId && byId.get(hereId);
      old?.classList.remove("oc-line--here");
      hereId = old === line ? null : line.dataset.id;
      if (hereId) line.classList.add("oc-line--here");
    });
    timers.push(setInterval(flushLines, FLUSH_MS));

    function addLine(line) {
      queue.push(line);
    }

    function addSystem(text, action) {
      const line = el("div", "oc-line oc-system", text);
      if (action) line.append(" ", button("oc-link", action.label, action.run));
      addLine(line);
      return line;
    }

    function chatLine(m) {
      const line = el("div", "oc-line");
      line.dataset.id = m.id;
      line.dataset.uid = m.userId;
      line.dataset.login = m.login;
      line.dataset.name = m.name;
      line.dataset.text = m.text || "";
      const ranks = (m.badges || []).map((b) => b.set_id);
      const sub = (m.badges || []).find((b) => b.set_id === "subscriber" || b.set_id === "founder");
      if (sub) line.dataset.sub = sub.info || "1"; // months, as Twitch's badge says
      if (m.color) line.dataset.color = m.color;
      if (ranks.includes("broadcaster") || ranks.includes("moderator")) line.dataset.staff = "1";
      if (host.isConnection(m.login)) line.classList.add("oc-line--connection");
      if (m.history) line.classList.add("oc-line--old");
      // How Twitch dressed the message up: a channel-points highlight, a gigantified emote.
      if (m.kind === "channel_points_highlighted" || m.kind === "power_ups_message_effect") line.classList.add("oc-line--highlight");
      if (m.kind === "power_ups_gigantified_emote") line.classList.add("oc-line--giant");
      if (m.reply) {
        const r = el("div", "oc-replied");
        r.textContent = `Replying to @${m.reply.parent_user_name}: ${m.reply.parent_message_body}`;
        line.append(r);
      }
      if (m.fromChannel) line.append(el("span", "oc-shared", m.fromChannel));
      for (const b of m.badges || []) {
        const badge = badges.get(`${b.set_id}/${b.id}`);
        if (!badge) continue;
        const img = el("img", "oc-badge");
        img.src = badge.url;
        img.alt = badge.title;
        img.title = badge.title;
        line.append(img);
      }
      // Mod icons, like Twitch's, before the name: ban, time out (10 minutes) and delete.
      // Only where you can use them (shown while you're a mod here; see .oc--mod), and not
      // on your own lines or other mods'. Settings can hide them ("modIcons").
      if (m.login !== me.login && !line.dataset.staff) line.append(modIcons(line));
      const who = button("oc-name", m.name, () => openCard(line));
      const color = safeColor(m.color);
      if (color) who.style.color = color;
      const body = el("span", "oc-body");
      try {
        drawMessage(body, m.fragments, m.text);
      } catch (err) {
        body.textContent = m.text;
        codeError(err);
      }
      if (m.bits) line.append(el("span", "oc-bits", `${m.bits} bits`), " ");
      const raid = !line.dataset.staff && m.login !== me.login && raidOf(m.login, m.history);
      if (raid) {
        line.classList.add("oc-line--raider");
        if (raid.color) {
          // In the raiding streamer's name colour, with words that stay readable on it.
          line.style.setProperty("--raid", raid.color);
          const [r, g, b] = [1, 3, 5].map((i) => parseInt(raid.color.slice(i, i + 2), 16));
          line.style.setProperty("--raid-ink", 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#18181b" : "#fff");
        }
        const tag = el("span", "oc-raidtag", "raid");
        tag.title = `Probably came in with ${raid.from}'s raid (they hadn't been in the chat before it)`;
        if (raid.pic) {
          // The raiding streamer's picture, small, so it's clear whose raid they came with.
          const pic = el("img", "oc-raidtag__pic");
          pic.src = raid.pic;
          pic.alt = "";
          tag.prepend(pic);
        }
        line.append(tag, " ");
      }
      line.append(who, ": ", body);
      byId.set(m.id, line);
      // Someone's first message in this channel, as Twitch marks it for mods. Twitch's
      // public chat says so (dock.js passes it on, see firstChat), and it can arrive before
      // or after the line itself.
      if (m.first || m.kind === "user_intro" || firstIds.delete(m.id)) markFirst(line, m.kind === "user_intro");
      return line;
    }

    const firstIds = new Set(); // first messages Twitch told us about before they arrived
    function markFirst(line, intro) {
      if (line.classList.contains("oc-line--first")) return;
      line.classList.add("oc-line--first");
      line.prepend(el("div", "oc-firsttag", intro ? "First-time chatter, introducing themselves" : "First-time chatter"));
    }

    // A removed line stops showing its words (this dock might be on screen), with a way
    // for a mod to look.
    function hideLine(line) {
      if (line.classList.contains("oc-line--gone")) return;
      line.classList.add("oc-line--gone");
      const body = line.querySelector(".oc-body");
      if (!body) return;
      body.hidden = true;
      const shown = button("oc-gone", "message deleted", () => {
        body.hidden = !body.hidden;
      });
      line.append(shown);
    }

    // ----- Who came with a raid ---------------------------------------------------------
    // Twitch's own chat highlights raiders, but doesn't tell apps who they are: a raid
    // notice only says which channel and how many. So this is a good guess: someone whose
    // first line since this page opened comes after a raid, and who wasn't in the chat
    // before it (dock.js passes on who's here from Twitch's public chat, see here()), is
    // marked as a raider for RAIDER_MS. Someone who happens to arrive at the same moment
    // gets marked too; in chats too big for Twitch to list who's here, only the first
    // half of that check applies.
    const raids = []; // { at, from, present: who was here then }
    const firstSpoke = new Map(); // login -> when this page first saw them chat
    const presentNow = new Set(); // who Twitch's public chat says is here
    function raidOf(login, old) {
      if (!firstSpoke.has(login)) firstSpoke.set(login, old ? 0 : Date.now());
      const first = firstSpoke.get(login);
      const now = Date.now();
      for (let i = raids.length - 1; i >= 0; i--) {
        const r = raids[i];
        if (now - r.at > RAIDER_MS) break;
        if (first >= r.at) return r.present.has(login) ? null : r;
      }
      return null;
    }
    // Twitch's full list, when this sign-in allows it (a mod's list of everyone here). Kept
    // fresh in the background, so at a raid the list from just before it is ready.
    let canListChatters = false;
    async function listChatters() {
      if (!canListChatters || !isMod || stopped) return;
      try {
        let cursor = "";
        for (let page = 0; page < 20; page++) {
          // Not api(): a refusal here mustn't count as the sign-in ending.
          const r = await fetch(`${urls.helix}/chat/chatters?${modQuery()}&first=1000${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`, {
            headers: { Authorization: `Bearer ${host.token()}`, "Client-Id": host.clientId },
          });
          if (!r.ok) return;
          const j = await r.json();
          for (const c of j.data || []) presentNow.add(String(c.user_login).toLowerCase());
          cursor = j.pagination?.cursor || "";
          if (!cursor) return;
        }
      } catch {}
    }
    (async () => {
      try {
        const r = await fetch(urls.validate, { headers: { Authorization: `OAuth ${host.token()}` } });
        if (!r.ok) return;
        const scopes = (await r.json()).scopes || [];
        canListChatters = EXTRA_SCOPES.every((sc) => scopes.includes(sc));
        if (canListChatters) {
          listChatters();
          timers.push(setInterval(listChatters, CHATTERS_EVERY_MS));
        } else if (host.onSignIn) {
          addSystem("Sign in once more to let custom chat use Twitch's list of who's here, so it marks raiders more accurately.", { label: "Sign in", run: () => host.onSignIn() });
        }
      } catch {}
    })();

    function gotRaid(from, pic, color) {
      raids.push({ at: Date.now(), from, pic, color, present: new Set(presentNow) });
      if (raids.length > 20) raids.shift();
    }

    // Twitch's chat notices: raids, subs and gifts, cheers' badges, announcements, and the
    // same from the other channels in a shared chat ("shared_chat_" in front).
    const SUB_NOTICES = ["sub", "resub", "sub_gift", "community_sub_gift", "gift_paid_upgrade", "prime_paid_upgrade", "pay_it_forward"];
    const ANNOUNCE_COLORS = { BLUE: "#00b5f0", GREEN: "#00db84", ORANGE: "#ff9a1f", PURPLE: "#a970ff" };
    function noticeLine(e) {
      const kind = String(e.notice_type || "").replace(/^shared_chat_/, "");
      const what = SUB_NOTICES.includes(kind) ? "sub" : kind === "bits_badge_tier" || kind === "charity_donation" ? "gold" : kind;
      const line = el("div", `oc-line oc-notice oc-notice--${what}`);
      const fromChannel = e.source_broadcaster_user_id && e.source_broadcaster_user_id !== broadcasterId ? e.source_broadcaster_user_name : "";
      if (kind === "raid" && e.raid) {
        // Who's raiding, with how many, their picture, and a quick welcome.
        const r = e.raid;
        const raidColor = safeColor(e.color);
        if (raidColor) line.style.setProperty("--raid", raidColor);
        const raidPic = r.profile_image_url ? r.profile_image_url.replace("%{width}", "70").replace("%{height}", "70") : "";
        if (!fromChannel) gotRaid(r.user_name || r.user_login, raidPic, raidColor);
        const head = el("div", "oc-raid");
        if (r.profile_image_url) {
          const pic = el("img", "oc-raid__pic");
          pic.src = raidPic;
          pic.alt = "";
          head.append(pic);
        }
        const words = el("div", "oc-raid__words");
        const name = el("a", "oc-raid__name", r.user_name || r.user_login);
        name.href = `https://www.twitch.tv/${encodeURIComponent(r.user_login || "")}`;
        name.target = "_blank";
        name.rel = "noopener noreferrer";
        const n = Number(r.viewer_count) || 0;
        words.append(el("div", "oc-raid__title", "Raid!"), name, ` is raiding with ${n.toLocaleString()} ${n === 1 ? "viewer" : "viewers"}`);
        if (fromChannel) words.append(` (to ${fromChannel})`);
        head.append(words);
        line.append(head);
        if (!fromChannel) {
          line.append(button("oc-act oc-raid__hi", "Welcome them", () => {
            input.value = `Welcome in, @${r.user_name || r.user_login} and the raiders! <3`;
            input.focus();
          }, "Puts a welcome in the message box for you to send"));
        }
        return line;
      }
      if (kind === "announcement") {
        const c = ANNOUNCE_COLORS[String(e.announcement?.color || "").toUpperCase()];
        if (c) line.style.setProperty("--notice", c);
        line.append(el("div", "oc-notice__head", `${e.chatter_user_name || "A moderator"} · Announcement`));
      } else {
        if (fromChannel) line.append(el("span", "oc-shared", fromChannel));
        line.append(el("div", "oc-notice__head", e.system_message || kind.replace(/_/g, " ") || "Notice"));
      }
      if (e.message?.text) {
        const body = el("div", "oc-body");
        drawMessage(body, e.message.fragments, e.message.text);
        line.append(body);
      }
      return line;
    }

    function gotEvent(type, e) {
      if (type === "channel.chat.message") {
        sawHere(e.chatter_user_login);
        if (known.has(e.message_id)) return;
        known.add(e.message_id);
        if (known.size > 5000) known.clear();
        addLine(chatLine({
          id: e.message_id,
          userId: e.chatter_user_id,
          login: e.chatter_user_login,
          name: e.chatter_user_name,
          color: e.color,
          badges: e.badges,
          fragments: e.message?.fragments,
          text: e.message?.text || "",
          reply: e.reply,
          kind: e.message_type,
          bits: e.cheer?.bits || 0,
          fromChannel: e.source_broadcaster_user_id && e.source_broadcaster_user_id !== broadcasterId ? e.source_broadcaster_user_name : "",
        }));
      } else if (type === "channel.chat.notification") {
        if (known.has(e.message_id)) return;
        known.add(e.message_id);
        addLine(noticeLine(e));
      } else if (type === "channel.chat.message_delete") {
        flushLines();
        const line = byId.get(e.message_id);
        if (line) hideLine(line);
      } else if (type === "channel.chat.clear_user_messages") {
        flushLines();
        list.querySelectorAll(`[data-uid="${CSS.escape(e.target_user_id)}"]`).forEach(hideLine);
        // A ban or time-out. Yours already says so (with Undo); someone else's says so here,
        // so lines don't just vanish. Twitch doesn't say which it was, or who did it.
        const mine = myBans.get(e.target_user_id);
        myBans.delete(e.target_user_id);
        if (!(mine && Date.now() - mine < 15000)) addSystem(`${e.target_user_name || "Someone"} was banned or timed out, so their messages were removed.`);
      } else if (type === "channel.chat.clear") {
        flushLines();
        list.querySelectorAll(".oc-line[data-id]").forEach(hideLine);
        addSystem("Chat was cleared by a moderator.");
      } else if (type === "automod.message.hold") gotHold(e);
      else if (type === "automod.message.update") {
        const row = heldEl.querySelector(`[data-id="${CSS.escape(e.message_id)}"]`);
        if (row) row.remove();
        heldEl.hidden = !heldEl.childElementCount;
      }
    }

    // ----- AutoMod ---------------------------------------------------------------------
    function gotHold(e) {
      const row = el("div", "oc-hold");
      row.dataset.id = e.message_id;
      const reason = e.reason === "blocked_term" ? "blocked term" : e.automod?.category || "AutoMod";
      const body = el("div", "oc-hold__text");
      body.append(el("b", "", e.user_name), ": ");
      const words = el("span");
      drawMessage(words, e.message?.fragments, e.message?.text || "");
      body.append(words, el("span", "oc-hold__why", ` (${reason})`));
      const act = (action) => async () => {
        try {
          const r = await api("/moderation/automod/message", { method: "POST", body: JSON.stringify({ user_id: me.id, msg_id: e.message_id, action }) });
          if (r.ok) {
            row.remove();
            heldEl.hidden = !heldEl.childElementCount;
          } else note(await why(r, "Twitch didn't accept that."));
        } catch {
          note("Couldn't reach Twitch. Try again.");
        }
      };
      row.append(body, button("oc-act oc-act--good", "Allow", act("ALLOW")), button("oc-act oc-act--bad", "Deny", act("DENY")));
      heldEl.append(row);
      heldEl.hidden = false;
    }

    // ----- Mod actions -----------------------------------------------------------------
    const modQuery = () => `broadcaster_id=${broadcasterId}&moderator_id=${me.id}`;

    async function deleteMessage(line) {
      try {
        const r = await api(`/moderation/chat?${modQuery()}&message_id=${encodeURIComponent(line.dataset.id)}`, { method: "DELETE" });
        if (r.ok) hideLine(line);
        else note(await why(r, "Twitch wouldn't delete that."));
      } catch {
        note("Couldn't reach Twitch. Try again.");
      }
    }

    async function unban(id, name) {
      try {
        const r = await api(`/moderation/bans?${modQuery()}&user_id=${encodeURIComponent(id)}`, { method: "DELETE" });
        if (r.ok) addSystem(`${name} can chat again.`);
        else note(await why(r, `Twitch wouldn't lift that for ${name}.`));
        return r.ok;
      } catch {
        note("Couldn't reach Twitch. Try again.");
        return false;
      }
    }

    const myBans = new Map(); // user id -> when you banned or timed them out here
    async function ban(id, name, seconds) {
      // Noted before asking: Twitch can report the removal before it answers.
      myBans.set(id, Date.now());
      try {
        const r = await api(`/moderation/bans?${modQuery()}`, { method: "POST", body: JSON.stringify({ data: { user_id: id, ...(seconds ? { duration: seconds } : {}) } }) });
        if (!r.ok) {
          myBans.delete(id);
          note(await why(r, `Twitch wouldn't do that to ${name}.`));
          return false;
        }
        addSystem(seconds ? `You timed out ${name}.` : `You banned ${name}.`, { label: "Undo", run: () => unban(id, name) });
        return true;
      } catch {
        myBans.delete(id);
        note("Couldn't reach Twitch. Try again.");
        return false;
      }
    }

    function modIcons(line) {
      const box = el("span", "oc-modicons");
      const { uid, name } = line.dataset;
      // A ban takes a second click within 3 seconds (the chat moves under the mouse);
      // a timeout and a delete are one click, and a ban or timeout can be undone.
      const banBtn = iconButton("oc-modicon oc-modicon--ban", "ban", async () => {
        if (!banBtn.dataset.sure) {
          banBtn.dataset.sure = "1";
          banBtn.classList.add("oc-modicon--sure");
          banBtn.title = `Click again to ban ${name}`;
          setTimeout(() => {
            delete banBtn.dataset.sure;
            banBtn.classList.remove("oc-modicon--sure");
            banBtn.title = `Ban ${name}`;
          }, 3000);
          return;
        }
        delete banBtn.dataset.sure;
        banBtn.classList.remove("oc-modicon--sure");
        await ban(uid, name);
      }, `Ban ${name}`);
      box.append(
        banBtn,
        iconButton("oc-modicon", "clock", () => ban(uid, name, 600), `Time out ${name} for 10 minutes`),
        iconButton("oc-modicon", "trash", () => deleteMessage(line), "Delete this message"),
      );
      return box;
    }

    // ----- A chatter's card, like Twitch's when you click a name -----------------------
    // Their picture and name, badges, when the account was made, how long they've
    // followed and been subscribed, their bio, what they've said here, and (for mods) the
    // timeout and ban buttons. Twitch's details load in a moment; they're kept a while.
    const people = new Map(); // user id -> { at, user, follow, channel }
    async function quiet(path) {
      // Not api(): a refusal here (say, a permission this sign-in doesn't have) mustn't
      // count as the sign-in ending.
      try {
        const r = await fetch(urls.helix + path, { headers: { Authorization: `Bearer ${host.token()}`, "Client-Id": host.clientId } });
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    }
    async function aboutPerson(uid) {
      const known = people.get(uid);
      if (known && Date.now() - known.at < 5 * 60 * 1000) return known;
      const [u, f, c] = await Promise.all([
        quiet(`/users?id=${encodeURIComponent(uid)}`),
        quiet(`/channels/followers?broadcaster_id=${broadcasterId}&user_id=${encodeURIComponent(uid)}`),
        quiet(`/channels?broadcaster_id=${encodeURIComponent(uid)}`),
      ]);
      const about = { at: Date.now(), user: u?.data?.[0] || null, follow: f ? f.data?.[0] || false : null, channel: c?.data?.[0] || null };
      people.set(uid, about);
      return about;
    }
    const longDate = (t) => new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    function howLong(t) {
      const days = Math.floor((Date.now() - new Date(t)) / 86400000);
      if (days < 1) return "today";
      if (days < 31) return `${days} ${days === 1 ? "day" : "days"}`;
      const months = Math.floor(days / 30.44);
      if (months < 12) return `${months} ${months === 1 ? "month" : "months"}`;
      const years = Math.floor(months / 12);
      const rest = months % 12;
      return `${years} ${years === 1 ? "year" : "years"}${rest ? `, ${rest} ${rest === 1 ? "month" : "months"}` : ""}`;
    }

    function openCard(line) {
      const { uid, name, login, staff, sub, color } = line.dataset;
      card.replaceChildren();
      card.dataset.uid = uid;
      const head = el("div", "oc-card__head");
      const pic = el("img", "oc-card__pic");
      pic.alt = "";
      pic.hidden = true;
      const who = el("div", "oc-card__who");
      const profile = el("a", "oc-card__name", name);
      profile.href = `https://www.twitch.tv/${encodeURIComponent(login)}`;
      profile.target = "_blank";
      profile.rel = "noopener noreferrer";
      const c = safeColor(color);
      if (c) profile.style.color = c;
      const badgeRow = el("div", "oc-card__badges");
      line.querySelectorAll(".oc-badge").forEach((b) => badgeRow.append(b.cloneNode()));
      if (line.classList.contains("oc-line--first")) badgeRow.append(el("span", "oc-card__flag oc-card__flag--first", "First-time chatter"));
      if (line.classList.contains("oc-line--raider")) {
        const raid = line.querySelector(".oc-raidtag");
        badgeRow.append(el("span", "oc-card__flag oc-card__flag--raid", raid?.title.replace(/ \(.*\)$/, "") || "Came with a raid"));
      }
      who.append(profile, badgeRow);
      const close = button("oc-card__close", "×", () => (card.hidden = true), "Close");
      head.append(pic, who, close);
      card.append(head);

      const facts = el("div", "oc-card__facts");
      const fact = (text) => facts.append(el("div", "oc-card__fact", text));
      if (sub) fact(`Subscribed for ${sub} ${sub === "1" ? "month" : "months"}`);
      const loading = el("div", "oc-card__fact oc-card__fact--wait", "Loading their details from Twitch…");
      facts.append(loading);
      card.append(facts);
      aboutPerson(uid).then(({ user, follow, channel }) => {
        if (card.dataset.uid !== uid) return; // another card opened since
        loading.remove();
        if (user?.profile_image_url) {
          pic.src = user.profile_image_url;
          pic.hidden = false;
        }
        if (user?.created_at) fact(`Account created ${longDate(user.created_at)} (${howLong(user.created_at)} ago)`);
        if (follow) fact(`Following since ${longDate(follow.followed_at)} (${howLong(follow.followed_at)})`);
        else if (follow === false) fact("Not following");
        if (channel?.game_name) fact(`Last streamed ${channel.game_name}`);
        if (user?.description) facts.append(el("div", "oc-card__bio", user.description));
        if (!user && follow === null) fact("Twitch didn't send their details.");
      });

      // What they've said here, newest last.
      const theirs = [...list.querySelectorAll(".oc-line[data-uid]")].filter((l) => l.dataset.uid === uid);
      const said = el("div", "oc-card__said");
      said.append(el("div", "oc-card__label", `${theirs.length} ${theirs.length === 1 ? "message" : "messages"} here`));
      for (const l of theirs.slice(-3)) said.append(el("div", `oc-card__msg${l.classList.contains("oc-line--gone") ? " oc-card__msg--gone" : ""}`, l.dataset.text || ""));
      card.append(said);

      if (isMod && login !== me.login && !(staff && channel !== me.login)) {
        const row = el("div", "oc-card__row");
        for (const [label, seconds] of TIMEOUTS) {
          row.append(button("oc-act", label, async () => {
            if (await ban(uid, name, seconds)) card.hidden = true;
          }, `Time out for ${label}`));
        }
        // A ban takes a second click, since the chat moves under the mouse.
        const banBtn = button("oc-act oc-act--bad", "Ban", async () => {
          if (banBtn.dataset.sure) {
            if (await ban(uid, name)) card.hidden = true;
            return;
          }
          banBtn.dataset.sure = "1";
          banBtn.textContent = "Really ban?";
          setTimeout(() => {
            delete banBtn.dataset.sure;
            banBtn.textContent = "Ban";
          }, 3000);
        });
        row.append(banBtn, button("oc-act", "Unban", async () => {
          if (await unban(uid, name)) card.hidden = true;
        }));
        card.append(row);
      }
      card.hidden = false;
    }

    // One set of line buttons, moved to whichever line the mouse is on.
    const tools = el("div", "oc-tools");
    let toolsLine = null;
    tools.append(
      iconButton("oc-tool oc-tool--mark", "bookmark", () => toolsLine && (toggleMark(toolsLine), drawToolMark()), "Bookmark for later"),
      iconButton("oc-tool", "reply", () => toolsLine && startReply(toolsLine), "Reply"),
      iconButton("oc-tool oc-tool--mod", "trash", () => toolsLine && deleteMessage(toolsLine), "Delete this message"),
    );
    list.addEventListener("mouseover", (e) => {
      const line = e.target.closest?.(".oc-line[data-id]");
      if (!line || line === toolsLine || line.classList.contains("oc-line--gone")) return;
      toolsLine = line;
      const canDelete = isMod && !line.dataset.staff;
      tools.querySelector(".oc-tool--mod").hidden = !canDelete;
      drawToolMark();
      line.append(tools);
    });

    // The bookmark tool: filled in on a bookmarked message.
    function drawToolMark() {
      const b = tools.querySelector(".oc-tool--mark");
      const on = !!toolsLine?.classList.contains("oc-line--marked");
      b.classList.toggle("oc-tool--on", on);
      b.title = on ? "Take the bookmark off" : "Bookmark for later";
      b.setAttribute("aria-label", b.title);
    }

    function startReply(line) {
      replyTo = line.dataset.id;
      replyEl.replaceChildren(`Replying to @${line.dataset.name} `, button("oc-link", "Cancel", cancelReply));
      replyEl.hidden = false;
      input.focus();
    }
    function cancelReply() {
      replyTo = null;
      replyEl.hidden = true;
    }

    // ----- Sending ---------------------------------------------------------------------
    // Sending trouble that isn't about the message itself. Twice in a row means sending
    // is broken, and a streamer needs to be able to talk.
    function sendTrouble(text) {
      note(text);
      if (++sendFailures >= 2) fail("sending messages stopped working");
    }

    async function command(text) {
      const [word, target, arg] = text.slice(1).trim().split(/\s+/);
      const cmd = (word || "").toLowerCase();
      if (!["ban", "unban", "timeout", "untimeout"].includes(cmd)) {
        note(`Custom chat can't run ${text[0]}${cmd || "that"} yet, so nothing was sent. "Use Twitch chat" above can.`);
        return false;
      }
      if (!isMod) {
        note("You aren't a mod here, so nothing was sent.");
        return false;
      }
      const login = (target || "").replace(/^@/, "").toLowerCase();
      if (!/^\w+$/.test(login)) {
        note(`Type a name after ${text[0]}${cmd}. Nothing was sent.`);
        return false;
      }
      let user;
      try {
        user = (await (await api(`/users?login=${encodeURIComponent(login)}`)).json()).data?.[0];
      } catch {}
      if (!user) {
        note(`Couldn't find ${login}. Nothing was sent.`);
        return false;
      }
      if (cmd === "unban" || cmd === "untimeout") return unban(user.id, user.display_name);
      if (cmd === "ban") return ban(user.id, user.display_name);
      const seconds = Number(arg) || 600;
      return ban(user.id, user.display_name, seconds);
    }

    async function send() {
      const text = input.value.trim();
      if (!text) return;
      if (text[0] === "/" || DOT_COMMANDS.test(text)) {
        if (await command(text)) input.value = "";
        return;
      }
      const sending = input.value;
      input.value = "";
      const repliedTo = replyTo;
      cancelReply();
      const putBack = () => {
        if (!input.value) input.value = sending;
      };
      try {
        const r = await api("/chat/messages", {
          method: "POST",
          body: JSON.stringify({ broadcaster_id: broadcasterId, sender_id: me.id, message: text, ...(repliedTo ? { reply_parent_message_id: repliedTo } : {}) }),
        });
        if (r.status === 401) return putBack();
        if (r.status >= 500 || r.status === 403) {
          putBack();
          return sendTrouble(await why(r, "Twitch didn't take that message."));
        }
        if (!r.ok) {
          putBack();
          return note(await why(r, "Twitch didn't take that message."));
        }
        sendFailures = 0;
        const sent = (await r.json()).data?.[0];
        if (sent && !sent.is_sent) {
          if (sent.drop_reason?.code !== "automod_held") putBack();
          note(sent.drop_reason?.message || "Twitch didn't send that message.");
        }
      } catch {
        putBack();
        sendTrouble("Couldn't reach Twitch. Your message is still in the box.");
      }
    }

    composer.addEventListener("submit", (e) => {
      e.preventDefault();
      send();
    });

    // Tab finishes an emote or a name that's been in the chat.
    let tabbing = null;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") cancelReply();
      if (e.key !== "Tab") {
        tabbing = null;
        return;
      }
      e.preventDefault();
      if (!tabbing) {
        const word = input.value.split(/\s/).pop();
        if (!word) return;
        const start = word.replace(/^@/, "").toLowerCase();
        const names = [...list.querySelectorAll(".oc-line[data-name]")].map((l) => `@${l.dataset.name}`);
        const options = [...new Set([...myEmotes.keys(), ...otherEmotes.keys(), ...names])].filter((n) => n.replace(/^@/, "").toLowerCase().startsWith(start));
        if (!options.length) return;
        tabbing = { before: input.value.slice(0, input.value.length - word.length), options, at: -1 };
      }
      tabbing.at = (tabbing.at + 1) % tabbing.options.length;
      input.value = `${tabbing.before}${tabbing.options[tabbing.at]} `;
    });

    // ----- Emote picker ----------------------------------------------------------------
    let pickerBuilt = false;
    function togglePicker() {
      picker.hidden = !picker.hidden;
      if (picker.hidden || pickerBuilt) return;
      pickerBuilt = true;
      const search = el("input", "oc-picker__search");
      Object.assign(search, { type: "search", placeholder: "Find an emote", name: "sbs-emote-search" });
      const grid = el("div", "oc-picker__grid");
      const draw = () => {
        const q = search.value.toLowerCase();
        const all = [...myEmotes, ...otherEmotes].filter(([name]) => name.toLowerCase().includes(q)).slice(0, 200);
        grid.replaceChildren(...all.map(([name, url]) => {
          const b = button("oc-picker__emote", "", () => {
            input.value = `${input.value}${input.value && !input.value.endsWith(" ") ? " " : ""}${name} `;
            input.focus();
          }, name);
          b.append(picture(url, name));
          return b;
        }));
        if (!all.length) grid.append(el("div", "oc-picker__none", "No emotes found"));
      };
      search.addEventListener("input", draw);
      picker.append(search, grid);
      draw();
    }

    // ----- Chat from before this page opened -------------------------------------------
    // Twitch only sends new messages, so this comes from a free service other chat apps
    // use too. If it's down, chat just starts empty.
    function historyLine(raw) {
      const match = raw.match(/^@(\S+) :(\w+)!\S+ PRIVMSG #\S+ :(.*)$/);
      if (!match) return null;
      const tags = Object.fromEntries(match[1].split(";").map((t) => {
        const i = t.indexOf("=");
        return [t.slice(0, i), t.slice(i + 1)];
      }));
      if (tags["rm-deleted"] === "1" || !tags.id) return null;
      const text = match[3];
      // Where the emotes are: "25:0-4,12-16/1902:6-10", counted in whole characters.
      const chars = [...text];
      const spots = [];
      for (const part of (tags.emotes || "").split("/").filter(Boolean)) {
        const [id, ranges] = part.split(":");
        for (const r of (ranges || "").split(",")) {
          const [from, to] = r.split("-").map(Number);
          if (Number.isInteger(from) && Number.isInteger(to)) spots.push({ id, from, to });
        }
      }
      spots.sort((a, b) => a.from - b.from);
      const fragments = [];
      let at = 0;
      for (const s of spots) {
        if (s.from > at) fragments.push({ type: "text", text: chars.slice(at, s.from).join("") });
        fragments.push({ type: "emote", text: chars.slice(s.from, s.to + 1).join(""), emote: { id: s.id } });
        at = s.to + 1;
      }
      if (at < chars.length) fragments.push({ type: "text", text: chars.slice(at).join("") });
      const months = (tags["badge-info"] || "").match(/(?:^|,)(?:subscriber|founder)\/(\d+)/)?.[1];
      const badgeList = (tags.badges || "").split(",").filter(Boolean).map((b) => {
        const [set_id, id] = b.split("/");
        return { set_id, id, info: set_id === "subscriber" || set_id === "founder" ? months : undefined };
      });
      known.add(tags.id);
      return chatLine({
        id: tags.id,
        userId: tags["user-id"] || "",
        login: match[2],
        name: (tags["display-name"] || match[2]).replace(/\\s/g, " "),
        color: tags.color,
        badges: badgeList,
        fragments,
        text,
        history: true,
        first: tags["first-msg"] === "1",
        bits: Number(tags.bits) || 0,
      });
    }

    async function loadHistory() {
      if (!urls.history) return;
      try {
        const j = await (await fetch(`${urls.history}/${encodeURIComponent(channel)}?limit=50`)).json();
        const lines = [];
        for (const raw of j.messages || []) {
          const id = raw.match(/(?:^@|;)id=([^;]+)/)?.[1];
          if (id && known.has(id)) continue;
          const line = historyLine(raw);
          if (line) lines.push(line);
        }
        if (!lines.length || stopped) return;
        const batch = document.createDocumentFragment();
        lines.forEach((l) => batch.append(l));
        list.prepend(batch);
        if (!held()) toBottom();
      } catch {}
    }

    // ----- Off we go -------------------------------------------------------------------
    (async () => {
      if (!broadcasterId) {
        try {
          broadcasterId = (await (await api(`/users?login=${encodeURIComponent(channel)}`)).json()).data?.[0]?.id || "";
        } catch {}
        if (!broadcasterId) return fail("it couldn't find the channel");
      }
      connect(`${urls.eventsub}?keepalive_timeout_seconds=${KEEPALIVE_S}`);
      // Pictures first where possible, but chat never waits for them.
      await Promise.all([loadBadges(), loadOtherEmotes()]);
      loadHistory();
      loadMyEmotes();
      timers.push(setInterval(loadOtherEmotes, 15 * 60 * 1000));
    })().catch(codeError);

    return {
      get ready() {
        return ready;
      },
      get lastOk() {
        return lastOk;
      },
      ircSaw,
      // Who Twitch's public chat says is in the chat (dock.js): for telling raiders apart.
      here(login) {
        if (login) presentNow.add(String(login).toLowerCase());
      },
      // Twitch's public chat marked this message as someone's first here (dock.js).
      firstChat(id) {
        if (!id) return;
        const line = byId.get(id);
        if (line) return markFirst(line);
        firstIds.add(id);
        if (firstIds.size > 200) firstIds.delete(firstIds.values().next().value);
      },
      // A mod flagged this chatter's line (dock.js): it glows in their colour from now on.
      // The newest line from them that matches; says whether it found one.
      glowLine({ chatter, text, color }) {
        const login = String(chatter || "").toLowerCase();
        const lines = [...list.querySelectorAll(".oc-line[data-login]")].filter((l) => l.dataset.login === login);
        const line = lines.reverse().find((l) => !text || l.dataset.text === text || text.startsWith(l.dataset.text) || l.dataset.text.startsWith(text)) || null;
        if (!line) return false;
        if (color) line.style.setProperty("--flag", color);
        line.classList.add("oc-line--flagged");
        return true;
      },
      // Closes everything and hands back anything typed but not sent.
      stop() {
        stopped = true;
        timers.forEach(clearInterval);
        clearTimeout(retryTimer);
        clearTimeout(noteTimer);
        removeEventListener("error", onPageError);
        if (socket) {
          socket.onclose = null;
          socket.onmessage = null;
          try {
            socket.close();
          } catch {}
        }
        const draft = input.value.trim();
        root.remove();
        return draft;
      },
    };
  }

  window.OwnChat = { SCOPES, EXTRA_SCOPES, start };
})();

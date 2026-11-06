// Streamer Buddy System: the hub where a streamer and the people around her
// (mods, regulars) ask each other quick questions. The same page runs as:
//   - the streamer's OBS dock (Docks → Custom Browser Docks), and its pop-out
//     windows (?popout)
//   - the hub in Twitch Space's Chrome side panel (?embed=ext, inside an
//     iframe: sign-in is handed over by the extension, see below)
//   - a phone deck (?deck), added to a home screen like an app: big tiles that
//     send a question, quick info or a !vanish note in one tap, like a Stream
//     Deck. It signs in with Twitch's code sign-in (twitch.tv/activate), since
//     home-screen apps can't always come back from a sign-in page
//   - a chat dock (?livechat, to use in place of OBS's Twitch chat dock): for a
//     streamer who's live, so just the one-row bar on top of Twitch's own embedded
//     chat. It receives everything but only sends messages and questions. A
//     connection's picture shows once they've been in the chat this stream: ringed
//     green, orange, yellow, then white by how recently they chatted, lit with no ring
//     when they're quiet, gray once they've left. ?channel=<name> shows another channel's chat
// Everyone talks through the relay (relay/ in this repo, on Cloudflare): a
// WebSocket that signs in with your Twitch sign-in, keeps connections and the
// week's questions, and says who's online. Questions wait there for anyone
// who's offline.
//
// What's on screen:
//   - the top bar: one profile-picture dot per connection, ring glowing green while
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
//     minutes) and "!vanish notes"
//     (30 seconds, fading in and out fuzzily); nothing's stored, so only people
//     online get them
//   - Stats: for each connection, what's public from Twitch (live, viewers,
//     followers, chat mode, next stream, latest clip) plus, if they share, what
//     their own OBS panel records: subs, gifts, bits, follows, raids, ad timing,
//     hype trains and viewer averages and highs (from the day it's switched on)
//   - cards below the bar when there's room: questions to you with six
//     one-tap answers or your own reply; answers to yours with "Mark as seen"
//     (the person who answered sees "✓ Seen", and a notice in the bar); nothing
//     clears by itself
//   - a streamer's one-row bar sends what isn't a question as a plain message: no
//     answer buttons, just "Mark as seen" (the streamer gets the notice) or a reply
//   - in the side panel, a button for how connections see you: online, idle or
//     offline
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
//   "chatToken"  custom chat's own sign-in (ownchat.js), never sent to the relay
//   "ownChat", "ownChatPicked", "ownChatFailed"  custom chat: on or off, picked Twitch's
//              chat by hand, and when and why it last fell back
//   "ui"       { question id: { closed, waitClosed, cleared, gone } }  what you've
//              closed or cleared here (per device; the relay keeps the rest)
//   "ids", "pics", "colors"  Twitch user ids, profile pictures, chat colours
//   "sound"    whether to make a sound when something arrives (on by default in OBS)
//   "pings"    what's been pinged, so a reload doesn't ping again
//   "lastTo"   who you last sent to, where sending starts from next time (OBS)
//   "chatBeen-<channel>"  { stream, logins } who's been in the chat this stream
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
  const DECK = params.has("deck");
  // Twitch only returns to the bare address after a sign-in, so the sign-in's
  // state remembers this was the chat dock.
  const LIVECHAT = !POPOUT && !EMBED && !DECK && (params.has("livechat") || (new URLSearchParams(location.hash.slice(1)).get("state") || params.get("state") || "").endsWith("-livechat"));
  const STREAMER = LIVECHAT || params.has("streamer"); // and the windows it pops out
  // The streamer's OBS panels get the glowing edge and pings (see "Pings" below).
  const PINGS_HERE = !POPOUT && !EMBED && !DECK;

  const svg =(paths, size = 18) => `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true">${paths}</svg>`;
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

  // A question's answer buttons, in the asker's order: { code, label }. The
  // asker's own options are code "x" with their label.
  const optionsOf = (q) => (q.options || STANDARD).map((o) => (o.startsWith("+") ? { code: "x", label: o.slice(1) } : { code: o, label: ANSWERS[o].label }));
  // The streamer's answers, whatever the asker offered: heart, check and X, heart on the
  // left. Anything else is a typed reply. The relay always accepts these three.
  const STREAMER_ANSWERS = ["t", "y", "n"];
  const answerChoices = (q) => (STREAMER ? STREAMER_ANSWERS.map((code) => ({ code, label: ANSWERS[code].label })) : optionsOf(q));
  // What an answer says: a typed reply or own option's words, else its label.
  const said = (a) => (a.code === "c" || a.code === "x" ? a.text : ANSWERS[a.code].label);

  const main = document.getElementById("main");
  const statusEl = document.getElementById("status");
  const dotsEl = document.getElementById("dots");
  const peekEl = document.getElementById("peek");
  const askBtn = document.getElementById("askBtn");
  const peopleBtn = document.getElementById("peopleBtn");
  const presenceBtn = document.getElementById("presenceBtn");
  const quickAsk = document.getElementById("quickAsk");
  const quickEl = document.getElementById("quick");
  const flashesEl = document.getElementById("flashes");
  const pinsEl = document.getElementById("pins");
  const quickTo = document.getElementById("quickTo");
  const quickText = document.getElementById("quickText");
  const askFull = document.getElementById("askFull");
  const statsBtn = document.getElementById("statsBtn");
  const chatBtn = document.getElementById("chatBtn");
  const chatCount = document.getElementById("chatCount");

  let me = null; // { login, id }
  const HOME_VIEW = DECK ? "deck" : "cards";
  let view = POPOUT && /^(ask|people|person|chat|stats)$/.test(params.get("view")) ? params.get("view") : HOME_VIEW; // "cards" | "deck" | "ask" | "people" | "person" | "chat" | "stats"
  const drafts = {}; // question id -> reply being typed (kept if things redraw)
  // The Ask box: who to, what's being typed, and what kind ("ask" | "info" | "love").
  // Every question offers the streamer's three answers: heart, check and X.
  const askDraft = { to: (POPOUT && params.get("to")) || "", text: "", note: "", options: ["t", "y", "n"], mode: "ask" };

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
  let myStatus = "online"; // how connections see you: "online" | "idle" | "offline"
  // Chat: the rooms you're in ({ owner, tag, members: [{ login, online }] }), and a
  // private chat with each mutual connection ({ owner, direct: true, with, members }),
  // and each one's recent messages ({ owner: [{ id, from, text, at }] }).
  let rooms = [];
  let chat = {};
  // Stats: what the relay has ({ login: worked-out stats }), whether you share
  // yours, and what Twitch says publicly ({ login: { ..., at } }).
  let stats = {};
  let views = {}; // Streamer View: streamer's login -> what their OBS dock shows (see "Streamer View")
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
          from: q.from, name: q.from, text: q.text, at: q.at, options: q.options, note: q.note, group: q.group, toTag: q.toTag, nudges: q.nudges || 0, warns: q.warns || 0,
          done: !!(q.answer || q.dismissed || (q.note && q.seenAt)), answered: q.answer, seenAt: q.seenAt,
          sending: !!pending[q.id], cleared: !!u.cleared, gone: !!u.gone,
        };
      } else if (q.from === me?.login) {
        sent[q.id] = {
          to: q.to, text: q.text, at: q.at, note: q.note, seenAt: q.seenAt, group: q.group, toTag: q.toTag, nudges: q.nudges || 0, nudgedAt: q.nudgedAt || 0, warns: q.warns || 0, warnedAt: q.warnedAt || 0, seen: !!u.waitClosed || !!q.dismissed, gone: !!u.gone,
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
  // Who sending starts with. In OBS: the last person you talked to (sent to or
  // answered), never a group, so a message doesn't go to everyone by accident; else
  // the first person. In the side panel: the streamer whose channel you're watching
  // (the extension says which), else the first choice.
  const KEEP_LAST_TO = !EMBED && !DECK;
  const isPerson = (t) => t && t !== "*" && !t.startsWith("#");
  function defaultTo() {
    const choices = targets();
    if (EMBED && choices.includes(watching)) return watching;
    if (!KEEP_LAST_TO) return choices[0];
    const last = get("lastTo", "");
    return choices.includes(last) && isPerson(last) ? last : choices.find(isPerson) || choices[0];
  }
  function rememberTo(to) {
    if (!KEEP_LAST_TO || !isPerson(to)) return;
    put("lastTo", to);
    if ([...quickTo.options].some((o) => o.value === to)) quickTo.value = to;
  }
  // What the bar sends: something that reads as a question gets the answer
  // buttons; anything else is a plain message.
  const QUESTION_START = /^(who|what|when|where|why|how|which|can|could|would|should|will|do|does|did|is|are|am|was|were|has|have|had|any|anyone|anybody)\b/i;
  const isQuestion = (text) => text.includes("?") || QUESTION_START.test(text);
  const askOrSay = (text) => (isQuestion(text) ? { options: STANDARD } : { note: true });
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
    statusEl.parentElement.title = text; // the glow can't be hovered, so the bar says it
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
    if (DECK) return codeSignIn();
    if (EMBED) return parent.postMessage({ t: "hub-signin" }, "*");
    const state = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + (LIVECHAT ? "-livechat" : "");
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

  // Custom chat's own sign-in, in the chat dock only (see ownchat.js).
  function ownChatSignIn() {
    const state = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}-ownchat-livechat`;
    put("signinState", state);
    const q = new URLSearchParams({
      response_type: "token",
      client_id: TWITCH_CLIENT_ID,
      redirect_uri: location.origin + location.pathname,
      scope: window.OwnChat.SCOPES.join(" "),
      state,
    });
    location.href = `https://id.twitch.tv/oauth2/authorize?${q}`;
  }

  // The phone deck: Twitch shows nothing here; you enter a code at
  // twitch.tv/activate (on this phone or anything else) and this waits for it.
  // It comes with a refresh token, so the sign-in renews itself.
  const TWITCH_TOKEN = "https://id.twitch.tv/oauth2/token";
  const form = (o) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o) });

  async function codeSignIn() {
    const scopes = get("statsWanted", false) ? STATS_SCOPES.join(" ") : SCOPES;
    let d;
    try {
      d = await (await fetch("https://id.twitch.tv/oauth2/device", form({ client_id: TWITCH_CLIENT_ID, scopes }))).json();
    } catch {}
    if (!d?.user_code) return showSignedOut("Couldn't reach Twitch. Try again.");
    const box = el("div", "signin");
    const link = el("a", "signin__btn signin__link", "Open twitch.tv/activate");
    link.href = d.verification_uri;
    link.target = "_blank";
    link.rel = "noopener";
    box.append(el("div", "signin__head", "Enter this code on Twitch"), el("div", "signin__code", d.user_code), link, el("p", "signin__sub", "Then come back here. This page signs in by itself."));
    main.replaceChildren(box);
    const stopAt = Date.now() + d.expires_in * 1000;
    const poll = async () => {
      if (Date.now() > stopAt) return showSignedOut("That code ran out. Try again.");
      try {
        const j = await (await fetch(TWITCH_TOKEN, form({ client_id: TWITCH_CLIENT_ID, scopes, device_code: d.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }))).json();
        if (j.access_token) {
          put("token", j.access_token);
          put("refresh", j.refresh_token);
          return start();
        }
      } catch {}
      setTimeout(poll, (d.interval || 5) * 1000);
    };
    poll();
  }

  // A fresh sign-in from the refresh token, if there is one.
  async function renewSignin() {
    const refresh = get("refresh");
    if (!refresh) return false;
    try {
      const r = await fetch(TWITCH_TOKEN, form({ client_id: TWITCH_CLIENT_ID, grant_type: "refresh_token", refresh_token: refresh }));
      const j = await r.json();
      if (j.access_token) {
        put("token", j.access_token);
        put("refresh", j.refresh_token);
        return true;
      }
      if (r.status === 400 || r.status === 401) localStorage.removeItem("refresh");
    } catch {}
    return false;
  }

  // Back from Twitch: keep the token and clear it out of the address.
  function takeTokenFromAddress() {
    if (!location.hash.includes("access_token") && !location.search.includes("error")) return;
    const h = new URLSearchParams(location.hash.slice(1));
    const state = h.get("state") || params.get("state");
    // Custom chat's sign-in can ban and delete, so it's kept apart from the ordinary one,
    // which is the one that goes to the relay.
    if (state && state === get("signinState") && h.get("access_token")) put(state.endsWith("-ownchat-livechat") ? "chatToken" : "token", h.get("access_token"));
    localStorage.removeItem("signinState");
    history.replaceState(null, "", location.pathname + (EMBED ? "?embed=ext" : LIVECHAT ? "?livechat" : ""));
    if (params.get("error")) return params.get("error_description") || params.get("error");
  }

  // The extension (our parent page) handing over a sign-in.
  addEventListener("message", (e) => {
    if (!EMBED || e.source !== parent || !String(e.origin).startsWith("chrome-extension://")) return;
    if (e.data?.t === "hub-token" && typeof e.data.token === "string") {
      put("token", e.data.token);
      start();
    }
    // The Twitch channel open in the tab beside the panel, for Streamer View.
    if (e.data?.t === "hub-channel") {
      watching = typeof e.data.channel === "string" ? e.data.channel.toLowerCase() : "";
      // The Ask box follows the stream you're in (until you pick someone else).
      if (me && targets().includes(watching)) askDraft.to = watching;
      render();
    }
  });

  async function validate() {
    const token = get("token");
    if (!token) return null;
    const r = await fetch("https://id.twitch.tv/oauth2/validate", { headers: { Authorization: `OAuth ${token}` } });
    if (r.status === 401) {
      if (await renewSignin()) return validate();
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
    if (!me?.expiresAt || DEMO || get("refresh")) return ""; // a refresh token renews by itself
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
    const tokens = [get("token"), get("chatToken")].filter(Boolean);
    shareSignin(null);
    localStorage.removeItem("token");
    localStorage.removeItem("refresh");
    localStorage.removeItem("chatToken");
    if (!DEV) {
      for (const token of tokens) {
        fetch("https://id.twitch.tv/oauth2/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: TWITCH_CLIENT_ID, token }),
        }).catch(() => {});
      }
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
      else if (m.t === "unflash") pinLeaving.get(m.id)?.();
      else if (m.t === "flashed") gotFlashed(m);
      else if (m.t === "view") gotView(m.owner, m.v);
      else if (m.t === "stats") {
        stats[m.owner] = m.s;
        if (view === "stats") render();
      }
      else if (m.t === "error") gotError(m);
    };
    ws.onclose = (e) => {
      if (ws !== socket) return;
      socket = null;
      if (e.code === 4001) {
        renewSignin().then((ok) => (ok ? connect() : showSignedOut("Your Twitch sign-in ran out. Sign in again.")));
        return;
      }
      setStatus("Reconnecting…", "retry");
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
    views = m.views || (DEMO ? views : {});
    lastView = ""; // a fresh connection: the relay hears this dock's view again
    statsOn = !!m.statsOn;
    myStatus = m.status || myStatus;
    collect();
    gotPins(m.pins || []);
    const had = new Set(Object.keys(questions));
    const before = { ...questions };
    for (const k of Object.keys(questions)) delete questions[k];
    for (const q of m.questions || []) {
      questions[q.id] = q;
      noticeSeen(before[q.id], q); // while we were reconnecting
    }
    ready = true;
    setStatus("Online", "ok");
    if (first) moveOldList();
    // Back from granting the stats permission: switch sharing on.
    if (first && !statsOn && get("statsAfterSignin", false) && STATS_SCOPES.every((sc) => me.scopes?.includes(sc))) {
      localStorage.removeItem("statsAfterSignin");
      relay({ t: "statsShare", on: true });
    }
    else if (!PINGS_HERE && (m.questions || []).some((q) => !had.has(q.id) && q.to === me.login)) arrived();
    loadPics();
    render();
  }

  function gotQuestion(q) {
    const old = questions[q.id];
    questions[q.id] = q;
    delete pending[q.id];
    nudging.delete(q.id);
    noticeSeen(old, q);
    // Something new for you: a question to you, or an answer to yours.
    if ((!old && q.to === me.login && !PINGS_HERE) || (q.from === me.login && q.answer && !old?.answer)) arrived();
    if (!old && q.from === me.login) {
      askDraft.text = "";
      askDraft.note = "";
      if (view === "ask") view = "cards"; // their page shows it in the log
    }
    render();
  }

  // Someone marked your answer or message seen: say so in the bar for a minute,
  // since a one-row dock has no cards to show it on. Their page's history keeps it.
  function noticeSeen(old, q) {
    if (POPOUT || !old || old.seenAt || !q.seenAt) return;
    const what = q.to === me.login && q.answer ? said(q.answer) : q.from === me.login && q.note ? q.text : "";
    if (what) gotFlash({ id: `seen-${q.id}`, kind: "seen", from: q.to === me.login ? q.from : q.to, to: me.login, text: what, at: Date.now() });
  }

  // ===== The quick strip ===================================================================
  // Each flash removes itself: info after 2 minutes, !vanish notes after 30
  // seconds, fuzzily. They're drawn once and left alone, so redrawing the rest of
  // the page doesn't restart their fade.
  //
  // A flagged chat line is a pin below the bar instead (in the strip if the dock
  // is just the bar): a copy of the line with its emotes, for 5 minutes. The
  // relay keeps it that long, and its X clears it for everyone who has it: the
  // streamer, their connections, and whoever flagged it.
  const FLASH_MS = { info: 120000, chat: 300000, love: 30000, seen: 60000 };
  const FUZZ_MS = 1400;
  const FLASH_ICONS = {
    info: `<path d="M11 2 4 11.5h5L8 18l7-9.5h-5z" ${LINE} stroke-width="1.7"/>`,
    love: '<path d="M10 17s-6.5-4-6.5-8.6A3.6 3.6 0 0 1 10 6.2a3.6 3.6 0 0 1 6.5 2.2C16.5 13 10 17 10 17z" fill="currentColor"/>',
    chat: `<path d="M3 4h14v9H8l-4 3v-3H3z" ${LINE} stroke-width="1.8"/>`,
    seen: `<path d="M4 10.5l4 4 8-9" ${LINE} stroke-width="2.4"/>`,
  };
  const seenFlashes = new Set();
  const pinLeaving = new Map(); // pinned line's id -> takes it away

  function gotPins(pins) {
    const still = new Set(pins.map((f) => f.id));
    for (const [id, leave] of pinLeaving) if (!still.has(id)) leave(); // cleared while we were away
    pins.forEach(gotFlash);
  }

  // Words, with emote names as their pictures.
  function withEmotes(text, emotes = {}) {
    return text.split(/(\s+)/).map((word) => {
      if (!Object.hasOwn(emotes, word)) return word;
      const img = el("img", "qflash__emote");
      img.src = emotes[word];
      img.alt = img.title = word;
      return img;
    });
  }

  function gotFlash(f) {
    const mine = f.to === me.login;
    if ((!mine && f.kind !== "chat") || seenFlashes.has(f.id)) return; // connections get flagged chat too
    seenFlashes.add(f.id);
    const late = Date.now() - (f.at || Date.now());
    if (f.kind !== "love" && mine && late < 5000) arrived(); // not when a reload brings back an old pin
    const chip = el("div", `qflash qflash--${f.kind}`);
    const color = f.color || colorOf(f.from);
    if (color && f.kind !== "love" && f.kind !== "seen") chip.style.setProperty("--c", color);
    const icon = el("span", "qflash__icon");
    icon.innerHTML = svg(FLASH_ICONS[f.kind], 15);
    if (f.kind === "chat") flaggerPicture(icon, f.from);
    const body = el("div", "qflash__body");
    body.title = f.kind === "chat" ? `${f.chatter}: ${f.text} (flagged by ${f.from})` : `${f.text} (${f.from})`;
    if (f.kind === "chat") {
      const name = el("b", null, f.chatterName || f.chatter);
      if (f.chatterColor) name.style.color = f.chatterColor;
      body.append(name, ": ", ...withEmotes(f.text, f.emotes), el("span", "qflash__who", ` flagged by ${f.from}${mine ? "" : ` in ${f.channel}`}`));
    } else if (f.kind === "seen") {
      body.title = `Seen by ${f.from}: ${f.text}`;
      body.append(el("b", null, `Seen by ${f.from}`), el("span", "qflash__who", ` ${f.text}`));
    } else {
      body.append(document.createTextNode(f.text), el("span", "qflash__who", ` ${f.from}`));
    }
    if (mine) {
      onScreen.set(f.id, { id: f.id, kind: f.kind, from: f.from, text: f.text, chatter: f.chatterName || f.chatter, chatterColor: f.chatterColor, color, at: f.at || Date.now() });
      shareView();
    }
    const leave = () => {
      if (chip.classList.contains("qflash--leaving")) return;
      chip.classList.add("qflash--leaving");
      pinLeaving.delete(f.id);
      if (onScreen.delete(f.id)) shareView();
      setTimeout(() => chip.remove(), FUZZ_MS);
    };
    const pinned = f.kind === "chat";
    const clear = () => {
      if (pinned) relay({ t: "unflash", id: f.id });
      leave();
    };
    chip.append(icon, body, closeButton(clear, pinned ? "Clear this for everyone" : "Clear this"));
    if (pinned) pinLeaving.set(f.id, leave);
    (pinned && (LIVECHAT || !short()) ? pinsEl : flashesEl).append(chip);
    setTimeout(leave, Math.max(0, FLASH_MS[f.kind] - FUZZ_MS - Math.max(0, late)));
  }

  // A flagged line's note shows who flagged it, once their picture's known.
  async function flaggerPicture(icon, login) {
    if (!pics[login]) await lookUp(login).catch(() => {});
    if (!pics[login]) return;
    const pic = el("img", "qflash__pic");
    pic.src = pics[login];
    pic.alt = "";
    icon.replaceChildren(pic);
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
    if (relay({ t: "flash", kind, to, text })) {
      askDraft.text = "";
      rememberTo(to);
    }
    render();
  }

  const directWith = (login) => rooms.find((r) => r.direct && r.with === login);

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
    if (chatDraft.owner === me.login || rooms.some((r) => r.owner === chatDraft.owner)) return chatDraft.owner;
    return (rooms.find((r) => r.owner === me.login) || rooms.find((r) => !r.direct) || rooms.find((r) => chat[r.owner]?.length))?.owner || "";
  }

  function gotError(m) {
    for (const k of Object.keys(pending)) delete pending[k];
    nudging.clear();
    if (m.why === "signin") return; // the socket closing next deals with it
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
    if (DECK) navigator.vibrate?.([80, 40, 80]);
    chime();
  }

  // Sound: on by default in the streamer's OBS panels, which is the point of a ping, and
  // off unless wanted elsewhere. OBS may pick the dock's sound up on stream if it captures
  // desktop audio; the switch is under Connections.
  const soundOn = () => get("sound", PINGS_HERE);
  let audio = null;
  function tones(freqs, gap, peak, length) {
    try {
      audio ||= new AudioContext();
      audio.resume();
      freqs.forEach((freq, i) => {
        const o = audio.createOscillator();
        const g = audio.createGain();
        const t = audio.currentTime + i * gap;
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(peak, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + length);
        o.connect(g).connect(audio.destination);
        o.start(t);
        o.stop(t + length + 0.05);
      });
    } catch {}
  }
  // Volume, from Settings: quiet, normal or loud.
  const VOLUME = { quiet: 0.5, normal: 1, loud: 1.6 };
  const vol = () => VOLUME[get("volume", "normal")] || 1;
  // Two soft notes.
  function chime() {
    if (!POPOUT && soundOn()) tones([659, 880], 0.14, 0.18 * vol(), 0.35);
  }
  // Something new: one clear note. A reminder (it moved up a colour): one softer note,
  // unless reminders are switched off in Settings.
  // A warning: two quick, higher notes, a little louder (even with reminders off).
  function ping(stage) {
    if (!soundOn()) return;
    if (stage === PING_WARN) return tones([1319, 1319], 0.16, 0.26 * vol(), 0.14);
    if (stage > 1 && !get("reminderBeeps", true)) return;
    tones([988], 0, (stage > 1 ? 0.13 : 0.22) * vol(), 0.22);
  }

  // ===== Pings =============================================================================
  // Someone needs the streamer. The edge of the panel glows (a thin, faint line), over
  // whichever chat is showing. Everything arrives green, with one clear note. If it isn't
  // answered, the person who asked can nudge it (q.nudges): each nudge moves it up a
  // colour (orange, yellow, then white) with one softer note and a brief flash of the
  // edge. Nothing climbs by itself. Answering, dismissing or marking it seen stops it.
  // Anything over an hour old when this panel first shows it doesn't ping or glow, unless
  // it's nudged after that.
  //
  // A warning (q.warns: the asker tapped Nudge over and over) is red, past white, with a
  // double beep each time one comes.
  const PING_NAMES = ["", "Green", "Orange", "Yellow", "White", "Red"];
  const PING_TOP = 4;
  const PING_WARN = 5;
  const PING_STALE_MS = 60 * 60 * 1000;
  const stageFor = (q) => (q.warns ? PING_WARN : Math.min(PING_TOP, 1 + (q.nudges || 0)));
  const pingLog = get("pings", {}); // question id -> { stage, stale }, kept so a reload doesn't ping again
  let pingGlow = null;
  let glowNow = 0; // the edge's colour right now (0 = no glow), for Streamer View

  // Looks at everything waiting; says whether anything moved up.
  function pingCheck() {
    // Not before the relay has said what's waiting, or a reload would look like nothing is.
    if (!PINGS_HERE || !me || !ready) return false;
    const now = Date.now();
    let glow = 0;
    let loudest = 0;
    let fresh = false; // something just arrived (gets the clear note, not the reminder)
    let warned = false; // a new warning (gets the double beep)
    let saveLog = false;
    for (const id of Object.keys(pingLog)) {
      if (inbox[id] && !inbox[id].done) continue;
      delete pingLog[id];
      saveLog = true;
    }
    for (const [id, q] of Object.entries(inbox)) {
      if (q.done || q.sending) continue;
      const stage = stageFor(q);
      if (!pingLog[id]) {
        const stale = now - q.at > PING_STALE_MS;
        pingLog[id] = { stage: stale ? stage : 0, stale }; // an old one counts as already pinged
        saveLog = true;
      }
      const log = pingLog[id];
      if (log.stale && stage <= log.stage) continue;
      log.stale = false; // nudged since: it's live again
      if ((q.warns || 0) > (log.warns || 0)) {
        log.warns = q.warns;
        warned = true;
        loudest = Math.max(loudest, PING_WARN);
        saveLog = true;
      }
      if (stage > log.stage) {
        if (!log.stage) fresh = true;
        log.stage = stage;
        loudest = Math.max(loudest, stage);
        saveLog = true;
      }
      glow = Math.max(glow, log.stage);
    }
    if (saveLog) put("pings", pingLog);
    if (!pingGlow) {
      pingGlow = el("div", "glow");
      pingGlow.setAttribute("aria-hidden", "true");
      document.body.append(pingGlow);
    }
    if (glow !== glowNow) pingGlow.className = glow ? `glow glow--${glow}` : "glow";
    glowNow = glow;
    // Something new (or up a colour): glow up now and start the 15-second cycle again,
    // on the edge and behind the message area. See .glow in dock.css.
    if (loudest && glow) {
      pingGlow.style.animation = "none";
      void pingGlow.offsetWidth;
      pingGlow.style.animation = "";
      peekEl.dataset.breath = peekEl.dataset.breath === "1" ? "0" : "1";
    }
    if (loudest) ping(warned ? PING_WARN : fresh ? 1 : loudest);
    return !!loudest;
  }

  // ===== Streamer View =====================================================================
  // At the top of the side panel: what the streamer's OBS dock is showing right now, so a
  // mod knows what's already in front of them before asking more. The streamer's dock (the
  // full dock or the chat dock, not pop-outs) sends the relay a summary whenever it
  // changes: the edge's glow, everything waiting for them (from anyone, with how far each
  // has glowed), answers to their own questions they haven't marked seen, and the notes and
  // flagged lines in their bar. The relay passes it to their mutual connections and drops
  // it when that dock closes. The side panel shows the streamer whose channel is open in
  // the Twitch tab beside it (the extension says which: "hub-channel"), else the first one
  // sharing, with a picker when there's more than one. It only shows; nothing's answered
  // from here.
  const MAX_VIEW_ITEMS = 12;
  const onScreen = new Map(); // flash id -> the note or flagged line in this dock's bar
  let lastView = "";
  let viewTimer = 0;
  // The channel in the Twitch tab beside the side panel. On this Mac, ?watch=<channel>
  // stands in for the extension saying so (testing without Chrome).
  let watching = (location.hostname === "localhost" && params.get("watch")?.toLowerCase()) || "";
  let svPicked = "";

  function viewNow() {
    const stageOf = (id) => (!pingLog[id]?.stale && pingLog[id]?.stage) || 0;
    const waiting = Object.keys(inbox)
      .filter((id) => !inbox[id].done)
      .sort((a, b) => stageOf(b) - stageOf(a) || inbox[b].at - inbox[a].at)
      .slice(0, MAX_VIEW_ITEMS)
      .map((id) => {
        const q = inbox[id];
        return { id, from: q.from, text: q.text, at: q.at, note: !!q.note, stage: stageOf(id), nudges: q.nudges, options: q.note ? [] : optionsOf(q).map((o) => o.label) };
      });
    const answers = Object.keys(sent)
      .filter((id) => sent[id].answer && !sent[id].answer.seen)
      .sort((a, b) => sent[b].answer.at - sent[a].answer.at)
      .slice(0, MAX_VIEW_ITEMS)
      .map((id) => ({ id, to: sent[id].to, text: sent[id].text, said: said(sent[id].answer), code: sent[id].answer.code, at: sent[id].answer.at }));
    const notes = [...onScreen.values()].slice(-MAX_VIEW_ITEMS);
    return { glow: glowNow, waiting, answers, notes, chat: LIVECHAT ? "livechat" : "dock" };
  }

  // The streamer's side: send it when it changes (gathered for a moment, as a burst of
  // things often arrives together).
  function shareView() {
    if (!PINGS_HERE || DEMO || !ready || !me) return;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      const v = get("shareView", true) ? viewNow() : null; // switched off in Settings: the relay drops it
      const json = JSON.stringify(v);
      if (json === lastView || socket?.readyState !== 1) return;
      lastView = json;
      socket.send(JSON.stringify({ t: "view", v }));
    }, 400);
  }

  function gotView(owner, v) {
    if (v) views[owner] = v;
    else delete views[owner];
    drawStreamerView();
  }

  // Whose view the panel shows.
  function svOwner() {
    const sharing = Object.keys(views).filter((l) => l !== me?.login);
    if (watching && sharing.includes(watching)) return watching;
    if (sharing.includes(svPicked)) return svPicked;
    return sharing[0] || "";
  }

  const svEl = document.getElementById("streamerView");
  function drawStreamerView() {
    if (!svEl) return;
    const owner = EMBED && me ? svOwner() : "";
    svEl.hidden = !owner;
    if (!owner) return svEl.replaceChildren();
    const v = views[owner];
    const open = get("svOpen", true);
    const sharing = Object.keys(views).filter((l) => l !== me.login);
    svEl.className = `sv${v.glow ? ` sv--glow sv--${v.glow}` : ""}${open ? "" : " sv--closed"}`;

    const head = el("div", "sv__head");
    const toggle = el("button", "sv__toggle");
    toggle.type = "button";
    toggle.title = open ? "Fold Streamer View away" : "Show Streamer View";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.append(el("span", "sv__title", "Streamer View"));
    const count = v.waiting.length;
    const says = v.glow ? `Glowing ${PING_NAMES[v.glow].toLowerCase()}` : count ? `${count} waiting` : "Nothing waiting";
    if (v.glow) toggle.append(el("span", `peek__ping peek__ping--${v.glow}`));
    toggle.append(el("span", "sv__says", says));
    toggle.addEventListener("click", () => {
      put("svOpen", !open);
      drawStreamerView();
    });
    head.append(toggle);
    if (sharing.length > 1) {
      const pick = el("select", "sv__pick");
      pick.title = watching === owner ? "Following the channel you're watching" : "Whose view";
      pick.replaceChildren(...sharing.map((l) => new Option(l, l)));
      pick.value = owner;
      pick.addEventListener("change", () => {
        svPicked = pick.value;
        watching = ""; // picked by hand: stop following the tab until it changes channel
        drawStreamerView();
      });
      head.append(pick);
    } else {
      const name = el("span", "sv__owner", owner);
      if (colorOf(owner)) name.style.color = colorOf(owner);
      head.append(name);
    }
    if (!open) return svEl.replaceChildren(head);

    const body = el("div", "sv__body");
    const who = (login) => {
      const b = el("b", "sv__who", login);
      if (colorOf(login)) b.style.color = colorOf(login);
      return b;
    };
    for (const q of v.waiting) {
      const row = el("div", `sv__row${q.stage ? ` sv__row--${q.stage}` : ""}`);
      row.title = q.nudges ? `Nudged ${q.nudges} time${q.nudges === 1 ? "" : "s"}` : q.text;
      row.append(el("span", `peek__ping peek__ping--${q.stage || 0}${q.stage ? "" : " sv__dot--quiet"}`));
      const text = el("div", "sv__text");
      text.append(who(q.from), document.createTextNode(` ${q.note ? "says" : "asks"}: `), el("span", null, q.text));
      if (q.from === me.login) text.append(el("span", "sv__tag", "yours"));
      row.append(text, el("span", "sv__ago", ago(q.at)));
      // Your own unanswered question: nudge it from here too.
      if (q.from === me.login && sent[q.id] && !q.note) row.append(nudgeButton([q.id]));
      body.append(row);
    }
    for (const a of v.answers) {
      const row = el("div", "sv__row sv__row--answer");
      const icon = el("span", `peek__icon answer--${a.code}`);
      icon.innerHTML = svg((ANSWERS[a.code] || ANSWERS.c).icon, 13);
      const text = el("div", "sv__text");
      text.append(who(a.to), document.createTextNode(" answered "), el("b", null, a.said), el("span", "sv__muted", ` · ${a.text}`));
      row.append(icon, text, el("span", "sv__ago", ago(a.at)));
      body.append(row);
    }
    for (const f of v.notes) {
      const row = el("div", `sv__row sv__note sv__note--${f.kind}`);
      if (f.color && f.kind !== "love" && f.kind !== "seen") row.style.setProperty("--c", f.color);
      const icon = el("span", "sv__icon");
      icon.innerHTML = svg(FLASH_ICONS[f.kind] || FLASH_ICONS.info, 13);
      const text = el("div", "sv__text");
      if (f.kind === "chat") {
        const name = el("b", null, f.chatter || "");
        if (f.chatterColor) name.style.color = f.chatterColor;
        text.append(name, `: ${f.text}`, el("span", "sv__muted", ` · flagged by ${f.from}`));
      } else if (f.kind === "seen") {
        text.append(el("b", null, `Seen by ${f.from}`), el("span", "sv__muted", ` · ${f.text}`));
      } else {
        text.append(document.createTextNode(f.text), el("span", "sv__muted", ` · ${f.from}${f.kind === "love" ? " (!vanish)" : ""}`));
      }
      row.append(icon, text);
      body.append(row);
    }
    if (!body.childElementCount) body.append(el("p", "sv__empty", "Their dock is clear: nothing waiting."));
    svEl.replaceChildren(head, body);
  }
  // Ages ("2 min ago") move on even when nothing new arrives.
  if (EMBED) setInterval(() => !svEl?.hidden && drawStreamerView(), 30000);

  // ===== Settings ==========================================================================
  // The gear at the top right of the streamer's OBS docks. Each is kept in this page's
  // localStorage, so OBS keeps it between restarts:
  //   "sound"          sound when something arrives (also under Connections)
  //   "volume"         "quiet" | "normal" | "loud"
  //   "reminderBeeps"  the softer note each time something waiting moves up a colour
  //   "edgeGlow"       the thin line round the edge
  //   "showQuick"      the quick-questions row (chat dock)
  //   "chatSize"       "small" | "normal" | "large": custom chat's text (chat dock)
  //   "shareView"      send Streamer View to your connections
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsEl = document.getElementById("settings");

  // What the switches change on screen, applied on load and on every change.
  function applySettings() {
    document.body.classList.toggle("no-edge", !get("edgeGlow", true));
    document.body.classList.toggle("hide-quick", !get("showQuick", true));
    document.body.classList.remove("chat-small", "chat-large");
    const size = get("chatSize", "normal");
    if (size !== "normal") document.body.classList.add(`chat-${size}`);
  }

  function drawSettings() {
    const sw = (key, label, fallback, after) => {
      const row = el("label", "set__row");
      const box = el("input", "set__switch");
      box.type = "checkbox";
      box.checked = get(key, fallback);
      box.addEventListener("change", () => {
        put(key, box.checked);
        applySettings();
        after?.(box.checked);
        drawSettings();
      });
      row.append(el("span", "set__label", label), box);
      return row;
    };
    const choice = (label, options, now, pick) => {
      const row = el("div", "set__row");
      const group = el("div", "set__seg");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", label);
      for (const [value, text] of options) {
        const b = el("button", `set__opt${value === now ? " set__opt--on" : ""}`, text);
        b.type = "button";
        b.setAttribute("aria-pressed", String(value === now));
        b.addEventListener("click", () => {
          pick(value);
          applySettings();
          drawSettings();
        });
        group.append(b);
      }
      row.append(el("span", "set__label", label), group);
      return row;
    };
    const head = (text) => el("div", "set__head", text);

    const parts = [head("Sound")];
    parts.push(sw("sound", "Sound when something arrives", PINGS_HERE, (on) => on && ping(1)));
    if (soundOn()) {
      parts.push(choice("Volume", [["quiet", "Quiet"], ["normal", "Normal"], ["loud", "Loud"]], get("volume", "normal"), (v) => {
        put("volume", v);
        ping(1); // hear what it sounds like
      }));
      parts.push(sw("reminderBeeps", "Softer reminder while it waits", true, (on) => on && ping(2)));
    }
    parts.push(el("p", "set__note", "If OBS captures your desktop audio, viewers may hear it too."));

    parts.push(head("Screen"));
    parts.push(sw("edgeGlow", "Glow round the edge", true));
    if (LIVECHAT) {
      parts.push(sw("showQuick", "Quick questions row", true, () => render()));
      if (get("ownChat", false) && window.OwnChat) {
        const twitch = get("ownChatPicked", "") === "twitch";
        parts.push(choice("Chat", [["own", "Custom"], ["twitch", "Twitch's"]], twitch ? "twitch" : "own", (v) => {
          if (v === "twitch" && !twitch) chooseTwitchChat();
          else if (v === "own" && twitch) tryOwnChatAgain();
        }));
        parts.push(choice("Chat text", [["small", "Small"], ["normal", "Normal"], ["large", "Large"]], get("chatSize", "normal"), (v) => put("chatSize", v)));
      }
    }

    parts.push(head("Mods"));
    parts.push(sw("shareView", "Share what this dock shows (Streamer View)", true, () => {
      lastView = ""; // send the change straight away
      shareView();
    }));
    parts.push(el("p", "set__note", "Your connections see it at the top of their Chrome side panel."));
    settingsEl.replaceChildren(...parts);
  }

  function openSettings(open) {
    settingsEl.hidden = !open;
    settingsBtn.classList.toggle("pill--on", open);
    settingsBtn.setAttribute("aria-expanded", String(open));
    if (open) drawSettings();
  }
  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openSettings(settingsEl.hidden);
  });
  // Clicking elsewhere, or Escape, closes it. (Clicks inside stop here: a switch redraws
  // the menu, so by the time the click reaches the page its target is gone.)
  settingsEl.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => !settingsEl.hidden && openSettings(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !settingsEl.hidden) openSettings(false);
  });
  applySettings();

  // ===== Doing things ======================================================================

  const clean = (s) => s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_LEN);

  function answer(id, code, reply) {
    if (pending[id]) return;
    if (relay({ t: "answer", id, code, text: reply || "" })) {
      pending[id] = true;
      rememberTo(questions[id]?.from); // answering someone counts as talking to them
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
    // A streamer's window sends statements plainly too, unless they picked buttons.
    const plain = STREAMER && !isQuestion(question);
    if (relay({ t: "ask", to, text: question, ...(plain ? { note: true } : { options: askDraft.options }) })) rememberTo(to);
  }

  // ===== Pop-outs (OBS) ====================================================================

  // The cards in a window of their own, in front, sized to fit. Null if OBS
  // (or the browser) won't open one. Not from the side panel, which has room.
  let popWin = null;
  // Never for the streamer: everything opens just under the bar instead (see "Inline").
  function popOut(show = "cards", to = "") {
    if (POPOUT) return window;
    if (EMBED || DECK || STREAMER) return null;
    const q = new URLSearchParams({ popout: "", view: show, to });
    if (STREAMER) q.set("streamer", "");
    if (DEMO) q.set("demo", "");
    if (DEV) q.set("dev", DEV);
    popWin = window.open(`${location.pathname}?${q}`, "streamer-buddy-popout", "popup,width=360,height=520");
    popWin?.focus();
    return popWin;
  }

  // Kept to one row: no room below the bar, so Ask and Connections pop out.
  const short = () => !POPOUT && !EMBED && !DECK && (LIVECHAT || innerHeight < 120);

  // Inline (the streamer's chat dock): what would have been a pop-out opens just under the
  // bar, over the top of the chat, with a Close at the top. The bar's own buttons close it
  // too, by pressing them again.
  let showAll = false; // the chat dock's full list of what's waiting, opened from "+2" or a picture
  const INLINE_TITLES = { cards: "Waiting for you", ask: "Ask", people: "Connections", chat: "Chat", stats: "Stats" };
  function inlineHead() {
    const head = el("div", "inline__head");
    head.append(el("span", "inline__title", view === "person" ? askDraft.to : INLINE_TITLES[view] || ""));
    const close = el("button", "inline__close", "Close");
    close.type = "button";
    close.addEventListener("click", () => {
      showAll = false;
      view = HOME_VIEW;
      render();
    });
    head.append(close);
    return head;
  }

  // Ask / Connections / someone's page: here, or popped out if the dock is just the bar.
  function show(next, to = "") {
    if (next === "chat" && to) chatDraft.owner = to;
    if (next === "stats" && to) statsDraft.who = to;
    if (next === "ask" || next === "person") {
      askDraft.to = to || askDraft.to;
      askDraft.note = "";
    }
    if (next !== "cards" && short() && popOut(next, to)) return;
    showAll = false;
    view = view === next && next !== "person" ? HOME_VIEW : next;
    render();
  }

  // ===== Drawing ===========================================================================

  function render() {
    if (!me) return;
    derive();
    pingCheck();
    // Keep typing where it was if things are redrawn under you.
    const typingIn = document.activeElement?.dataset?.key;
    main.replaceChildren(view === "people" ? peoplePanel() : view === "ask" ? askPanel() : view === "person" ? personPanel(askDraft.to) : view === "chat" ? chatPanel() : view === "stats" ? statsPanel() : view === "deck" ? deckPanel() : cardList());
    if (LIVECHAT && (view !== "cards" || showAll) && main.firstElementChild?.childElementCount !== 0) main.prepend(inlineHead());
    if (view === "chat") main.querySelector(".chat__log")?.scrollTo(0, 1e9);
    drawDots();
    drawPeek();
    drawStreamerView();
    shareView();
    settingsBtn.hidden = !PINGS_HERE || !me;
    if (typingIn) {
      const again = document.querySelector(`[data-key="${typingIn}"]`);
      again?.focus();
      again?.setSelectionRange?.(again.value.length, again.value.length);
    }
    askBtn.classList.toggle("pill--on", DECK ? view === "deck" : view === "ask" || (view === "cards" && !short() && get("askOpen", true)));
    peopleBtn.classList.toggle("pill--on", view === "people");
    peopleBtn.classList.toggle("pill--badge", requests.length > 0);
    peopleBtn.title = requests.length ? `Connections (${requests.length} waiting for you to add them back)` : "Connections";
    askBtn.textContent = DECK ? "Deck" : view === "ask" ? "Cancel" : "Ask";
    drawQuickAsk();
    drawPresence();
    statsBtn.hidden = STREAMER || (!connections.length && !statsOn);
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
    quickAsk.hidden = quickEl.hidden = !inBar;
    askFull.hidden = !inBar || LIVECHAT;
    askBtn.hidden = inBar || !me;
    if (!inBar) return;
    const choices = targets();
    const want = choices.includes(quickTo.value) ? quickTo.value : defaultTo();
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
      b.title = `Send to ${targetLabel(quickTo.value || defaultTo())}: ${text}`;
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

  // Side panel only: how your connections see you. The button opens a little menu of the
  // three to pick from.
  const STATUS = {
    online: { label: "Online", says: "Your connections see you as online." },
    idle: { label: "Idle", says: "Shown as away for a bit." },
    offline: { label: "Offline", says: "Shown as offline. Things still reach you here." },
  };
  const presenceMenu = el("div", "presence__menu");
  presenceMenu.setAttribute("role", "menu");
  presenceMenu.hidden = true;
  presenceBtn.after(presenceMenu);
  function drawPresence() {
    presenceBtn.hidden = !EMBED;
    if (!EMBED) return;
    const now = STATUS[myStatus] || STATUS.online;
    presenceBtn.className = `pill presence presence--${myStatus}${presenceMenu.hidden ? "" : " pill--on"}`;
    presenceBtn.textContent = now.label;
    presenceBtn.title = `${now.says} Click to change.`;
    presenceBtn.setAttribute("aria-haspopup", "menu");
    presenceBtn.setAttribute("aria-expanded", String(!presenceMenu.hidden));
  }
  function openPresence(open) {
    presenceMenu.hidden = !open;
    if (open) {
      presenceMenu.style.left = `${Math.max(4, Math.min(presenceBtn.offsetLeft, innerWidth - 228))}px`; // under the button
      presenceMenu.replaceChildren(...Object.entries(STATUS).map(([status, { label, says }]) => {
        const item = el("button", `presence__item${status === myStatus ? " presence__item--on" : ""}`);
        item.type = "button";
        item.setAttribute("role", "menuitemradio");
        item.setAttribute("aria-checked", String(status === myStatus));
        item.append(el("span", `presence presence--${status}`, label), el("span", "presence__says", says));
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          if (status !== myStatus && relay({ t: "status", status })) myStatus = status;
          openPresence(false);
        });
        return item;
      }));
    }
    drawPresence();
  }
  // Clicking elsewhere, or Escape, closes it.
  document.addEventListener("click", (e) => !presenceMenu.hidden && !presenceMenu.contains(e.target) && e.target !== presenceBtn && openPresence(false));
  document.addEventListener("keydown", (e) => e.key === "Escape" && !presenceMenu.hidden && openPresence(false));

  // The dots: one per connection; glowing green ring while online, faded until they've
  // added you back; pulsing in their chat colour for a question from them,
  // ringed for their answer to yours, with how many.
  function drawDots() {
    const dots = connections.map(({ login, mutual, online, idle }) => {
      const fromThem = Object.values(inbox).filter((q) => q.from === login && !q.done);
      const asks = fromThem.length;
      const answers = Object.values(sent).filter((q) => q.to === login && q.answer && !q.answer.seen).length;
      const direct = directWith(login);
      const said = direct ? unread(direct.owner) : 0; // private messages only count; they don't pulse
      // The chat dock: only people who are or have been in the chat this stream (or
      // have something waiting). Bright while they're there, faded once they leave.
      const light = LIVECHAT && mutual ? liveLight(login) : null;
      if (LIVECHAT && !(asks + answers + said) && !(light && liveWasHere(login))) return null;
      const dot = el("button", `dot${asks ? " dot--ask" : answers ? " dot--answer" : ""}${mutual ? "" : " dot--waiting"}${online && !LIVECHAT ? " dot--online" : ""}${idle ? " dot--idle" : ""}${light?.ring ? ` dot--${light.ring}` : ""}${light?.away ? " dot--away" : light && !light.ring ? " dot--here" : ""}`);
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
        : asks ? `${login} ${fromThem.every((q) => q.note) ? "sent you a message" : "asked you something"}`
        : answers ? `${login} answered you`
        : said ? `${login} sent you a message`
        : light ? `${login}: ${light.says}${idle ? ", set to idle" : ""}`
        : `${login}${idle ? " (idle)" : online ? " (online)" : ""}`;
      if (pics[login]) {
        const img = el("img");
        img.src = pics[login];
        img.alt = "";
        dot.append(img);
      } else {
        dot.append(el("span", "dot__letter", login[0].toUpperCase()));
      }
      if (asks + answers + said) dot.append(el("span", "dot__count", String(asks + answers + said)));
      dot.addEventListener("click", () => {
        if (asks + answers) {
          view = "cards";
          showAll = true;
          popOut();
          render();
        } else if (said) {
          show("chat", direct.owner);
        } else {
          show("person", login);
        }
      });
      return dot;
    });
    dotsEl.replaceChildren(...dots.filter(Boolean));
  }

  function cardList() {
    const wrap = el("div", "cards");
    if (signinNote()) wrap.append(signinPill());
    // The chat dock: the newest is in the bar; all of them only when asked for ("+2" or a
    // picture), just under the bar.
    if (LIVECHAT && !showAll) return wrap;
    if (!POPOUT && !DECK && !LIVECHAT) wrap.append(composer(null)); // the chat dock sends from its bar
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

    if (LIVECHAT && wrap.childElementCount === (signinNote() ? 1 : 0)) {
      showAll = false; // all dealt with: fold away
      return el("div", "cards");
    }
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
    card.append(el("div", "qcard__head", `${q.name} ${q.note ? "says" : "asks"}${q.group ? ` ${q.note ? "to " : ""}${askedWho(q)}` : ""}`), el("div", "qcard__text", q.text));
    const buttons = el("div", "qcard__answers");
    for (const { code, label } of answerChoices(q)) {
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
    // A plain message: no answer buttons, just say you've seen it (or reply).
    if (q.note) {
      const seen = el("button", "qcard__answer qcard__seen", q.sending ? "Sending…" : "Mark as seen");
      seen.type = "button";
      seen.title = `Let ${q.name} know you've seen this`;
      seen.disabled = q.sending;
      seen.addEventListener("click", () => ack(id));
      buttons.append(seen);
    }
    const x = el("button", "qcard__dismiss", q.note ? "Dismiss" : "Dismiss without answering");
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

  // The bar's message area: what's waiting for you (questions and messages to you, and
  // answers to your questions you haven't marked seen), one at a time, with its answers;
  // or else a connection request. In the streamer's chat dock it's the place to look:
  // boxed, a little larger, in the colour of what it shows.
  //
  // More than one: they take turns, a new one every PEEK_TURN_MS, with dots for how many
  // and which (click one to show it). Something new jumps straight in. It holds still
  // while the pointer is over it or you're typing a reply. "See all" opens the full list.
  const PEEK_TURN_MS = 6000;
  let peekId = "";
  let peekSince = 0;
  const peekKnown = new Set();
  // Pointer over it (tracked, as OBS's docks don't always report :hover), or typing a reply.
  let peekHover = false;
  peekEl.addEventListener("pointerenter", () => (peekHover = true));
  peekEl.addEventListener("pointerleave", () => {
    peekHover = false;
    peekSince = Math.max(peekSince, Date.now() - PEEK_TURN_MS + 2000); // a moment before it moves on
  });
  const peekHeld = () => peekHover || peekEl.matches(":hover") || peekEl.contains(document.activeElement) || !!drafts[peekId];

  function peekItems() {
    // The most urgent first, so the first one shown is the one causing the glow.
    const stageOf = (id) => (PINGS_HERE && !pingLog[id]?.stale && pingLog[id]?.stage) || 0;
    const open = Object.keys(inbox).filter((id) => !inbox[id].done).sort((a, b) => stageOf(b) - stageOf(a) || inbox[b].at - inbox[a].at);
    const answers = Object.keys(sent).filter((id) => sent[id].answer && !sent[id].answer.seen).sort((a, b) => sent[b].answer.at - sent[a].answer.at);
    return { stageOf, items: [...open.map((id) => ({ id, kind: "q" })), ...answers.map((id) => ({ id, kind: "a" }))] };
  }

  // Every second: time for the next one?
  setInterval(() => {
    if (!me || !peekId) return;
    const { items } = peekItems();
    if (items.length < 2 || Date.now() - peekSince < PEEK_TURN_MS || peekHeld()) return;
    const at = items.findIndex((it) => it.id === peekId);
    peekId = items[(at + 1) % items.length].id;
    peekSince = Date.now();
    drawPeek();
    // A soft slide-in, so the change is noticed.
    peekEl.style.animation = "none";
    void peekEl.offsetWidth;
    peekEl.style.animation = "";
  }, 1000);

  function drawPeek() {
    const { stageOf, items } = peekItems();
    // Something new jumps in (not the ones already there when the page opened).
    const fresh = items.find((it) => !peekKnown.has(it.id));
    const firstLook = !peekKnown.size;
    items.forEach((it) => peekKnown.add(it.id));
    if (fresh && !firstLook && !peekHeld()) {
      peekId = fresh.id;
      peekSince = Date.now();
    }
    if (!items.some((it) => it.id === peekId)) {
      peekId = items[0]?.id || "";
      peekSince = Date.now();
    }
    const current = items.find((it) => it.id === peekId);

    const parts = [];
    const who = (login, text) => {
      const name = el("span", "peek__who", text);
      if (colorOf(login)) name.style.color = colorOf(login);
      return name;
    };
    peekEl.className = "peek";
    if (current?.kind === "q") {
      const id = current.id;
      const q = inbox[id];
      const stage = stageOf(id);
      peekEl.classList.add("peek--on", `peek--${stage || 1}`);
      const line = el("div", "peek__line");
      line.title = q.text;
      if (stage) line.append(el("span", `peek__ping peek__ping--${stage}`));
      line.append(who(q.from, q.name), el("span", "peek__text", q.text));
      const buttons = el("div", "peek__answers");
      for (const { code, label } of answerChoices(q)) {
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
      if (q.note) {
        const seen = el("button", "pill pill--on", q.sending ? "Sending…" : "Mark as seen");
        seen.type = "button";
        seen.title = `Let ${q.name} know you've seen this`;
        seen.disabled = q.sending;
        seen.addEventListener("click", () => ack(id));
        parts.push(line, seen, own, closeButton(() => dismiss(id), "Dismiss"));
      } else {
        parts.push(line, buttons, own, closeButton(() => dismiss(id), "Dismiss without answering"));
      }
    } else if (current?.kind === "a") {
      const id = current.id;
      const q = sent[id];
      const a = ANSWERS[q.answer.code];
      peekEl.classList.add("peek--on", "peek--answer");
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
    if (items.length > 1) {
      // Which one this is, of how many: a dot each (click to show it), then See all.
      const pager = el("div", "peek__pager");
      items.forEach((it, k) => {
        const dot = el("button", `peek__dot${it.id === peekId ? " peek__dot--on" : ""}`);
        dot.type = "button";
        dot.title = `${k + 1} of ${items.length}`;
        dot.setAttribute("aria-label", dot.title);
        if (it.kind === "q" && stageOf(it.id)) dot.classList.add(`peek__dot--${stageOf(it.id)}`);
        dot.addEventListener("click", () => {
          peekId = it.id;
          peekSince = Date.now();
          drawPeek();
        });
        pager.append(dot);
      });
      const all = el("button", "pill pill--more", "See all");
      all.type = "button";
      all.title = `See all ${items.length}`;
      all.addEventListener("click", () => {
        view = "cards";
        showAll = true;
        if (short()) popOut();
        render();
      });
      pager.append(all);
      parts.push(pager);
    }
    peekEl.replaceChildren(...parts);
  }

  // A question you asked that hasn't been answered yet (for everyone: how
  // many have answered so far).
  function waitingRow(id) {
    const q = sent[id];
    const copies = q.group ? Object.entries(sent).filter(([, c]) => c.group === q.group) : [[id, q]];
    const answered = copies.filter(([, c]) => c.answer).length;
    const seenBy = copies.filter(([, c]) => c.seenAt).length;
    const row = el("div", "waiting");
    const text = el("div", "waiting__text");
    const who = q.note
      ? (q.group ? `Sent to ${askedWho(q)} (${seenBy} of ${copies.length} seen): ` : `Sent to ${q.to}${q.seenAt ? " · ✓ Seen" : ""}: `)
      : q.group ? `Waiting on ${askedWho(q)} (${answered} of ${copies.length} answered): ` : `Waiting on ${q.to}: `;
    text.append(el("span", "waiting__who", who), document.createTextNode(q.text));
    row.append(text);
    const unanswered = copies.filter(([, c]) => !c.answer && !c.seen).map(([cid]) => cid);
    if (!q.note && unanswered.length) row.append(nudgeButton(unanswered));
    row.append(closeButton(() => {
      for (const [cid] of copies) ui[cid] = { ...ui[cid], waitClosed: true };
      setUi(id, {});
    }, "Stop showing this"));
    return row;
  }

  // Nudge: remind them of a question you asked that's still unanswered. On their screen
  // it moves up a colour each time: orange, yellow, then white (see "Pings"). For a
  // question to several people, it nudges everyone who hasn't answered.
  //
  // While it can't be nudged (just nudged, or already white), the button still takes
  // taps: WARN_TAPS of them in quick succession sends a warning, red on their screen with a
  // louder beep. At most one every WARN_GAP_MS (the relay's limits too).
  const NUDGE_GAP_MS = 15 * 1000;
  const WARN_GAP_MS = 30 * 1000;
  const WARN_TAPS = 6;
  const WARN_WINDOW_MS = 4000;
  const warnTaps = new Map(); // ids key -> [tap times]
  function nudgeButton(ids) {
    const qs = ids.map((id) => sent[id]).filter(Boolean);
    const key = ids.join();
    const nudges = Math.max(0, ...qs.map((q) => q.nudges));
    const warns = Math.max(0, ...qs.map((q) => q.warns));
    const next = Math.min(PING_TOP, nudges + 2); // the colour a nudge turns it
    const done = nudges >= PING_TOP - 1;
    const wait = Math.max(0, ...qs.map((q) => q.nudgedAt + NUDGE_GAP_MS - Date.now()));
    const warnWait = Math.max(0, ...qs.map((q) => q.warnedAt + WARN_GAP_MS - Date.now()));
    const canNudge = !done && wait <= 0;
    const taps = (warnTaps.get(key) || []).filter((t) => Date.now() - t < WARN_WINDOW_MS);
    const busy = ids.some((id) => nudging.has(id));
    const colour = warns ? PING_WARN : canNudge ? next : done ? PING_TOP : nudges + 1;
    const b = el("button", `nudge nudge--${colour}${warns ? " nudge--warned" : ""}${taps.length ? " nudge--arming" : ""}`);
    b.type = "button";
    const label = taps.length ? `Warn: ${WARN_TAPS - taps.length} more` : warns ? "Warned" : canNudge ? (nudges ? "Nudge again" : "Nudge") : done ? "Nudged 3×" : "Nudged";
    b.append(el("span", `peek__ping peek__ping--${colour}`), el("span", null, label));
    b.disabled = busy || (!canNudge && warnWait > 0);
    b.title = canNudge
      ? `Remind them: it turns ${PING_NAMES[next].toLowerCase()} on their screen, with a soft beep`
      : warnWait > 0 ? "A warning was just sent; give them a moment"
      : `Tap ${WARN_TAPS} times quickly to send a warning (red on their screen, louder beep)`;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (canNudge) {
        for (const id of ids) relay({ t: "nudge", id });
        ids.forEach((id) => nudging.add(id));
        warnTaps.delete(key);
        return render();
      }
      // Tapping while it can't be nudged: count towards a warning.
      const now = [...(warnTaps.get(key) || []).filter((t) => Date.now() - t < WARN_WINDOW_MS), Date.now()];
      if (now.length >= WARN_TAPS) {
        warnTaps.delete(key);
        for (const id of ids) relay({ t: "nudge", id, warn: true });
        ids.forEach((id) => nudging.add(id));
      } else {
        warnTaps.set(key, now);
        setTimeout(() => render(), WARN_WINDOW_MS + 50); // the count runs out if they stop
      }
      render();
    });
    const soonest = [wait, warnWait].filter((ms) => ms > 0);
    if (soonest.length) setTimeout(() => render(), Math.min(...soonest) + 50);
    return b;
  }
  const nudging = new Set(); // question ids: sent, waiting for the relay to say so

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
  if (DECK && localStorage.getItem("askOpen") === null) put("askOpen", false);
  let quickSent = ""; // the quick question just sent, shown as "Sent" for a moment

  function sendQuick(text) {
    const to = quickTo.value || defaultTo();
    if (relay({ t: "ask", to, text, ...askOrSay(text) })) {
      rememberTo(to);
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
    if (conn(login)?.online) chip.append(el("span", `ask__online${conn(login).idle ? " ask__online--idle" : ""}`));
    return chip;
  }

  // Ask one of your connections a question (a pop-out from a one-row bar).
  function askPanel() {
    const panel = el("div", "panel");
    panel.append(composer(null, true));
    return panel;
  }

  // The Ask box, open at the top unless you fold it away (remembered). Pick who (fixed on
  // someone's page), then type: the switch at the left of the typing bar says whether
  // it's a question (answered with heart, check or X, or a typed reply), a quick note, or
  // a !vanish note.
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
    if (!fixedTo && !able.length) {
      box.append(el("p", "ask__hint", "Add someone under Connections first. You can ask each other once you've both added each other."));
      return box;
    }

    // Who to ask: the chosen person, with a caret that drops down the rest.
    if (!fixedTo) {
      if (!targets().includes(askDraft.to)) askDraft.to = defaultTo();
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
    const input = textBox(mode === "love" ? "Say something quick (it won't stick around)" : mode === "info" ? "What do they need to know?" : "What do you want to ask?", askDraft.text);
    input.dataset.key = fixedTo ? `ask-${fixedTo}` : "ask";
    input.className = "ask__input";
    input.maxLength = mode === "love" ? 80 : MAX_LEN;
    input.addEventListener("input", () => (askDraft.text = input.value));
    const send = el("button", "ask__send");
    send.type = "submit";
    send.title = "Send";
    send.setAttribute("aria-label", "Send");
    send.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 16V4M5 9l5-5 5 5"/></svg>`;
    // What you're sending, picked right in the typing bar: a question, a quick note, or
    // a !vanish note. A streamer only asks.
    const field = el("div", `ask__field ask__field--${mode}`);
    if (!STREAMER) {
      const pickMode = el("select", "ask__modepick");
      pickMode.title = "What you're sending";
      pickMode.setAttribute("aria-label", "What you're sending");
      for (const [value, label] of [["ask", "Ask"], ["info", "Quick info"], ["love", "!vanish"]]) pickMode.append(new Option(label, value));
      pickMode.value = mode;
      pickMode.addEventListener("change", () => {
        askDraft.mode = pickMode.value;
        askDraft.note = "";
        render();
        document.querySelector(`[data-key="${input.dataset.key}"]`)?.focus();
      });
      field.append(pickMode);
    }
    field.append(input);
    form.append(field, send);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const question = clean(input.value);
      if (!question) return;
      if (mode === "ask") ask(to(), question);
      else sendFlash(mode, to(), question);
    });
    box.append(form);

    // Say what happens to it.
    box.append(el("p", "ask__hint", askDraft.sent === mode ? "Sent ✓"
      : mode === "love" ? "Shows on their bar with your name, then disappears after 30 seconds."
      : mode === "info" ? "For things like incoming raids or minor technical difficulties. Shows on their bar with your name for 2 minutes. Only reaches people who are online."
      : "They answer with ♥, ✓ or ✗, or type a reply."));
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
    head.append(name, el("span", `person__state${c.idle ? " person__state--idle" : c.online ? " person__state--on" : ""}`, !c.mutual ? "hasn't added you yet" : c.idle ? "idle" : c.online ? "online" : "offline"));
    panel.append(head);
    if (c.mutual) panel.append(composer(login));
    const direct = directWith(login);
    if (direct) {
      const n = unread(direct.owner);
      const talk = el("button", "pill person__chat", "Private chat");
      talk.type = "button";
      talk.title = `A chat only you and ${login} can see`;
      if (n) talk.append(el("span", "pill__count", String(n)));
      talk.addEventListener("click", () => show("chat", direct.owner));
      panel.append(talk);
    }

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
    const verb = q.note ? "said" : "asked";
    body.append(el("div", "log__who", `${mine ? `You ${verb}` : `${login} ${verb}`} · ${ago(q.at)}`), el("div", "log__q", q.text));
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
    } else if (q.note) {
      out.append(el("span", `receipt${q.seenAt ? " receipt--seen" : ""}`, q.seenAt ? "✓ Seen" : q.dismissed ? "Dismissed" : "Not seen yet"));
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

  // Chat: one room per streamer, open to one of their tags, plus a private chat
  // between any two connections (opened from their page; listed once it's been
  // used). Pick one, read and post; a room's owner picks the tag or closes it.
  // @name pings someone.
  function chatPanel() {
    const panel = el("div", "panel chat");
    const owner = chatRoom();
    const room = rooms.find((r) => r.owner === owner);
    const mine = rooms.find((r) => r.owner === me.login);

    const listed = rooms.filter((r) => !r.direct || r.owner === owner || chat[r.owner]?.length);
    const canOpen = !mine && Object.keys(tags).length;
    if (listed.length + (canOpen ? 1 : 0) > 1) {
      const pick = el("div", "chat__rooms");
      if (canOpen) {
        const b = el("button", `pill${owner === me.login ? " pill--on" : ""}`, "Your room");
        b.type = "button";
        b.addEventListener("click", () => {
          chatDraft.owner = me.login;
          render();
        });
        pick.append(b);
      }
      for (const r of listed) {
        const n = unread(r.owner);
        const b = el("button", `pill${r.owner === owner ? " pill--on" : ""}`, r.direct ? r.with : r.owner === me.login ? "Your room" : `${r.owner}'s room`);
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
      panel.append(el("div", "panel__head", "Chat"));
      const names = Object.keys(tags).sort();
      if (!names.length) {
        panel.append(el("p", "panel__sub", "To talk privately with someone, click their picture, then Private chat. A streamer can also open a room for a tag (like Mods) and everyone in it can talk here."));
        return panel;
      }
      panel.append(el("p", "panel__sub", "Open a room for one of your tags. Everyone in it can talk to each other here, and you can read along (it stays quiet for you unless someone @mentions you)."));
      panel.append(roomPicker(null, "Open room"));
      return panel;
    }

    const head = el("div", "chat__head");
    head.append(el("span", "chat__title", room.direct ? `Private chat · only you and ${room.with}` : room.owner === me.login ? `Your room · ${room.tag}` : `${room.owner}'s room · ${room.tag}`));
    const who = el("span", "chat__who");
    for (const m of room.members.filter((m) => !room.direct || m.login !== me.login)) {
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
    const input = textBox(room.direct ? `Message ${room.with}…` : "Message the room…", chatDraft.text);
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
    box.checked = soundOn();
    box.addEventListener("change", () => {
      put("sound", box.checked);
      if (box.checked) chime();
    });
    sound.append(box, document.createTextNode(" Sound when something arrives"));
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

  // ===== The phone deck ====================================================================
  // Big tiles, each one tap: a question, quick info or a !vanish note to whoever's
  // picked at the top. "Edit" adds and removes tiles (saved on this phone).

  const DECK_TILES = [
    { kind: "ask", text: "Clip that!" },
    { kind: "ask", text: "Anyone free to help?" },
    { kind: "info", text: "Your mic is muted" },
    { kind: "info", text: "Game audio is loud" },
    { kind: "info", text: "Stream is lagging" },
    { kind: "info", text: "Check chat" },
    { kind: "love", text: "You've got this" },
    { kind: "love", text: "Looking good today" },
  ];
  const DECK_KINDS = { ask: "Question", info: "Quick info", love: "!vanish note" };
  const deckTiles = () => get("deckTiles", DECK_TILES);
  const deckState = { editing: false, sent: -1, kind: "info", text: "" };

  function sendTile(tile, i, to) {
    const sentOk = tile.kind === "ask"
      ? relay({ t: "ask", to, text: tile.text, options: STANDARD })
      : relay({ t: "flash", kind: tile.kind, to, text: tile.text });
    if (!sentOk) return;
    navigator.vibrate?.(30);
    deckState.sent = i;
    render();
    setTimeout(() => {
      if (deckState.sent === i) deckState.sent = -1;
      render();
    }, 1500);
  }

  function deckPanel() {
    const panel = el("div", "deckp");
    const choices = targets();
    if (!choices.length) {
      panel.append(el("p", "panel__sub", "Nobody to send to yet. Add people with the two-people icon; you can reach each other once you've both added each other."));
      return panel;
    }

    // Who gets it.
    const want = get("deckTo", "");
    const to = choices.includes(want) ? want : choices[0];
    const who = el("label", "deckp__who");
    who.append(el("span", null, "To"));
    const pick = el("select");
    for (const t of choices) pick.append(new Option(targetLabel(t), t, false, t === to));
    pick.addEventListener("change", () => put("deckTo", pick.value));
    const edit = el("button", `pill${deckState.editing ? " pill--on" : ""}`, deckState.editing ? "Done" : "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => {
      deckState.editing = !deckState.editing;
      render();
    });
    who.append(pick, edit);
    panel.append(who);

    // Anything waiting on you comes first.
    const answers = Object.keys(sent).filter((id) => sent[id].answer && !sent[id].answer.seen);
    const open = Object.keys(inbox).filter((id) => !inbox[id].done);
    for (const id of open) panel.append(questionCard(id));
    for (const id of answers) panel.append(answerCard(id));
    for (const login of requests) panel.append(requestRow(login));

    // The tiles.
    const grid = el("div", "deckp__grid");
    deckTiles().forEach((tile, i) => {
      const b = el("button", `tile tile--${tile.kind}${deckState.sent === i ? " tile--sent" : ""}`);
      b.type = "button";
      const icon = el("span", "tile__icon");
      icon.innerHTML = svg(tile.kind === "ask" ? ANSWERS.m.icon : FLASH_ICONS[tile.kind], 20);
      b.append(icon, el("span", "tile__text", deckState.sent === i ? "Sent ✓" : tile.text));
      b.addEventListener("click", () => {
        if (deckState.editing) return;
        sendTile(tile, i, pick.value);
      });
      if (deckState.editing) {
        const x = el("span", "tile__x", "×");
        x.addEventListener("click", () => {
          put("deckTiles", deckTiles().filter((_, k) => k !== i));
          render();
        });
        b.append(x);
      }
      grid.append(b);
    });
    panel.append(grid);

    // Adding a tile.
    if (deckState.editing) {
      const add = el("form", "deckp__add");
      const kind = el("select");
      for (const [k, label] of Object.entries(DECK_KINDS)) kind.append(new Option(label, k, false, k === deckState.kind));
      kind.addEventListener("change", () => (deckState.kind = kind.value));
      const text = textBox("What the tile sends", deckState.text);
      text.dataset.key = "deck-add";
      text.maxLength = 80;
      text.addEventListener("input", () => (deckState.text = text.value));
      const go = el("button", "pill pill--on", "Add");
      go.type = "submit";
      add.append(kind, text, go);
      add.addEventListener("submit", (e) => {
        e.preventDefault();
        const words = clean(text.value);
        if (!words) return;
        put("deckTiles", [...deckTiles(), { kind: kind.value, text: words }]);
        deckState.text = "";
        render();
      });
      panel.append(add);
      panel.append(el("p", "panel__sub", "Tiles are saved on this phone. Questions offer the six standard answers."));
    }
    if (askDraft.note) panel.append(el("p", "ask__note", askDraft.note));

    // Type something once, without a tile.
    panel.append(composer(null));
    return panel;
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

  // ===== Twitch chat (?livechat) ===========================================================
  // Twitch's own chat, embedded as it is, below the top section. A page can't
  // reach inside it, so nothing here changes it; flagged lines pin above it.
  //
  // Who's in chat, for the pictures in the bar, comes from Twitch's public chat
  // connection, as an anonymous viewer: who says something, and who's there. Twitch
  // reports arrivals within about a minute in small chats; a very big chat (xQc's,
  // when tried) reported none, so only people chatting light up there. It doesn't
  // always say when someone leaves, so a fresh connection takes attendance every few
  // minutes: Twitch reports everyone there to a newcomer.
  const LIVE_RECHECK_MS = DEV && params.has("recheck") ? Number(params.get("recheck")) : 3 * 60 * 1000; // ?recheck=<ms> for testing
  const LIVE_ATTENDANCE_MS = (DEV && params.has("mock") ? 3 : 90) * 1000; // the pretend Twitch answers at once
  // Twitch's public chat, or the pretend one (dev/mock-twitch.js) on this Mac.
  const IRC_URL = () => (location.hostname === "localhost" && params.has("mock") ? `ws://${location.host}/mock/irc` : "wss://irc-ws.chat.twitch.tv:443");
  let liveChannel = "";
  const liveChatters = new Set(); // logins Twitch says are in the chat
  let liveSaid = {}; // connection's login -> when they last chatted here (saved, for restarts)
  let liveListed = false; // attendance named people here, so it can be trusted over who chatted
  const liveLeft = new Set(); // Twitch said they left, and they haven't been back
  let liveBeen = { stream: "", logins: [] }; // who's been in the chat this stream (saved, for restarts)

  // Their light, while they're in the chat: a ring for how recently they chatted, green
  // within 5 minutes, then orange (10), yellow (20) and white (30); after that, or if they
  // haven't chatted, no ring, just their picture lit up. Not in the chat: gray, no ring.
  // Until attendance has named people (it never does in very big chats), chatting in
  // the last 30 minutes counts as being there. ?lightms=<ms> on this Mac counts a
  // "minute" as that long, for testing.
  const LIGHT_MINUTE = (location.hostname === "localhost" && Number(params.get("lightms"))) || 60 * 1000;
  function liveLight(login) {
    const min = liveSaid[login] ? (Date.now() - liveSaid[login]) / LIGHT_MINUTE : Infinity;
    const here = liveChatters.has(login) || (!liveListed && !liveLeft.has(login) && min <= 30);
    const chatted = min === Infinity ? "" : `chatted ${Math.max(1, Math.round(min))} min ago`;
    if (!here) return { ring: "", away: true, says: `not in chat${chatted && `, ${chatted}`}` };
    const ring = min <= 5 ? "light5" : min <= 10 ? "light10" : min <= 20 ? "light20" : min <= 30 ? "light30" : "";
    return { ring, away: false, says: chatted ? `in chat, ${chatted}` : "in chat, lurking" };
  }

  // Are they, or have they been, in the chat this stream? Once seen, they stay.
  function liveWasHere(login) {
    if (liveChatters.has(login) && !liveBeen.logins.includes(login)) {
      liveBeen.logins.push(login);
      put(`chatBeen-${liveChannel}`, liveBeen);
    }
    return liveBeen.logins.includes(login);
  }

  // A new stream starts the list again, with whoever's in the chat right now.
  // Between streams it's left alone. (?stream=<anything> pretends, on this Mac.)
  async function liveCheckStream() {
    let started = DEV ? params.get("stream") : "";
    if (!DEV && !DEMO) {
      try {
        started = (await (await helix(`/streams?user_login=${liveChannel}`)).json()).data?.[0]?.started_at;
      } catch {
        return;
      }
    }
    if (!started || started === liveBeen.stream) return;
    liveBeen = { stream: started, logins: [] };
    put(`chatBeen-${liveChannel}`, liveBeen);
    liveSaid = {};
    put(`chatSaid-${liveChannel}`, liveSaid);
    liveLeft.clear();
    drawDots();
  }

  function liveJoin(ws) {
    ws.send("CAP REQ :twitch.tv/membership");
    ws.send("PASS SCHMOOPIIE");
    ws.send(`NICK justinfan${Math.floor(Math.random() * 90000) + 10000}`);
    ws.send(`JOIN #${liveChannel}`);
  }

  function liveRecheck() {
    const ws = new WebSocket(IRC_URL());
    const there = new Set();
    ws.onopen = () => liveJoin(ws);
    ws.onmessage = (e) => {
      for (const line of e.data.split("\r\n")) {
        if (line.startsWith("PING")) ws.send("PONG :tmi.twitch.tv");
        const login = line.match(/^:(\w+)!\S+ JOIN /)?.[1];
        if (login) there.add(login);
      }
    };
    setTimeout(() => {
      ws.close();
      // Twitch always reports us joining, so empty means this connection failed.
      if (there.size) {
        liveListed = there.size > 1;
        liveChatters.clear();
        there.forEach((login) => liveChatters.add(login));
        // Chatted in the last moments: here, whatever the list has caught up with.
        for (const [login, at] of Object.entries(liveSaid)) if (Date.now() - at < LIVE_ATTENDANCE_MS) liveChatters.add(login);
        drawDots();
      }
      setTimeout(liveRecheck, LIVE_RECHECK_MS);
    }, LIVE_ATTENDANCE_MS);
  }

  function liveListen() {
    const ws = new WebSocket(IRC_URL());
    ws.onopen = () => {
      liveChatters.clear();
      liveJoin(ws);
    };
    ws.onmessage = (e) => {
      let changed = false;
      for (const line of e.data.split("\r\n")) {
        if (line.startsWith("PING")) ws.send("PONG :tmi.twitch.tv");
        else if (line.includes(" RECONNECT")) ws.close();
        const names = line.match(/ 353 \S+ = #\S+ :(.*)$/)?.[1];
        if (names) {
          for (const login of names.split(" ")) liveChatters.add(login);
          changed = true;
        }
        const [, login, what] = line.match(/^:(\w+)!\S+ (JOIN|PART|PRIVMSG) /) || [];
        if (what === "PRIVMSG") {
          try {
            ownChat?.ircSaw(login); // lets custom chat check it isn't missing messages
          } catch {}
        }
        if (!login || !trusted().includes(login)) continue;
        changed = true;
        if (what === "JOIN") {
          liveChatters.add(login);
          liveLeft.delete(login);
        } else if (what === "PART") {
          liveChatters.delete(login);
          liveLeft.add(login);
        } else {
          liveChatters.add(login);
          liveLeft.delete(login);
          liveSaid[login] = Date.now();
          put(`chatSaid-${liveChannel}`, liveSaid);
        }
      }
      if (changed) drawDots();
    };
    ws.onclose = () => setTimeout(liveListen, 5000);
  }

  // ----- Which chat shows -----------------------------------------------------------------
  // Twitch's own chat unless custom chat (ownchat.js) is switched on and working. Add
  // &ownchat to the address to switch it on, &ownchat=off to switch it off. Whatever goes
  // wrong with custom chat ends in chatFallback, which needs nothing but this page: it
  // shuts custom chat down and puts Twitch's chat in its place. This file also watches
  // custom chat from outside, in case its own checks are what's broken.
  const OWNCHAT_START_MS = 15 * 1000; // must be connected by then
  const OWNCHAT_SILENCE_MS = 30 * 1000; // ownchat.js gives up at 20, so this is the backstop
  const OWNCHAT_RETRY_AFTER_MS = 30 * 60 * 1000; // if it failed this recently, don't start on it
  const MOCK = location.hostname === "localhost" && params.has("mock"); // dev/mock-twitch.js
  let ownChat = null;
  let ownChatWatch = 0;
  let ownChatStartTimer = 0;
  let chatTurn = 0; // anything still waiting from an earlier attempt is ignored

  const chatToken = () => get("chatToken", "");
  const chatUrls = () => (MOCK
    ? { helix: `${location.origin}/mock/helix`, eventsub: `ws://${location.host}/mock/ws`, validate: `${location.origin}/mock/validate`, history: `${location.origin}/mock/history`, otherEmotes: false }
    : { helix: HELIX, eventsub: "wss://eventsub.wss.twitch.tv/ws", validate: "https://id.twitch.tv/oauth2/validate", history: "https://recent-messages.robotty.de/api/v2/recent-messages", otherEmotes: true });

  function showTwitchChat(strip) {
    const box = document.getElementById("live");
    const frame = el("iframe", "live__frame");
    frame.title = `${liveChannel}'s Twitch chat`;
    frame.src = `https://www.twitch.tv/embed/${liveChannel}/chat?parent=${encodeURIComponent(location.hostname)}&darkpopout`;
    box.replaceChildren(...(strip ? [chatStrip(strip)] : []), frame);
  }

  // The slim line above Twitch's chat, when there's something to say about custom chat.
  function chatStrip({ text, unsent, label, run }) {
    const strip = el("div", "live__strip");
    const words = el("span", "live__stripText", text);
    words.title = text;
    strip.append(words);
    if (unsent) strip.append(el("span", "live__stripUnsent", `Not sent: ${unsent}`));
    const go = el("button", "live__stripBtn", label);
    go.type = "button";
    go.addEventListener("click", run);
    strip.append(go);
    return strip;
  }

  function stopOwnChat() {
    chatTurn++;
    clearInterval(ownChatWatch);
    clearTimeout(ownChatStartTimer);
    let draft = "";
    try {
      draft = ownChat?.stop() || "";
    } catch {}
    ownChat = null;
    return draft;
  }

  const tryOwnChatAgain = () => {
    localStorage.removeItem("ownChatFailed");
    put("ownChatPicked", "");
    chatBegin();
  };

  function chatFallback(reason) {
    const unsent = stopOwnChat();
    put("ownChatFailed", { at: Date.now(), reason });
    showTwitchChat({ text: `Switched to Twitch's chat because ${reason}.`, unsent, label: "Try custom chat again", run: tryOwnChatAgain });
  }

  // The streamer picked Twitch's chat, and that's remembered until they pick otherwise.
  function chooseTwitchChat() {
    const unsent = stopOwnChat();
    put("ownChatPicked", "twitch");
    showTwitchChat({ text: "Using Twitch's chat.", unsent, label: "Use custom chat", run: tryOwnChatAgain });
  }

  // Custom chat's sign-in, checked before anything depends on it.
  async function chatSigninProblem() {
    const token = chatToken();
    if (!token) return "needs";
    const r = await fetch(chatUrls().validate, { headers: { Authorization: `OAuth ${token}` } });
    if (r.status === 401) {
      localStorage.removeItem("chatToken");
      return "needs";
    }
    if (!r.ok) throw new Error(`Twitch said ${r.status}`);
    const j = await r.json();
    const mine = MOCK || j.user_id === me.id;
    return mine && window.OwnChat.SCOPES.every((s) => (j.scopes || []).includes(s)) ? "" : "needs";
  }

  async function chatBegin() {
    stopOwnChat();
    const turn = chatTurn;
    try {
      if (params.get("ownchat") === "off") put("ownChat", false);
      else if (params.has("ownchat")) put("ownChat", true);
      if (!get("ownChat", false)) return showTwitchChat();
      if (!window.OwnChat) return showTwitchChat({ text: "Custom chat didn't load, so this is Twitch's chat.", label: "Reload", run: () => location.reload() });
      if (get("ownChatPicked", "") === "twitch") return showTwitchChat({ text: "Using Twitch's chat.", label: "Use custom chat", run: tryOwnChatAgain });
      const failed = get("ownChatFailed", null);
      if (failed && Date.now() - failed.at < OWNCHAT_RETRY_AFTER_MS) {
        return showTwitchChat({ text: `Using Twitch's chat because ${failed.reason} earlier.`, label: "Try custom chat again", run: tryOwnChatAgain });
      }
      ownChatStartTimer = setTimeout(() => turn === chatTurn && !ownChat?.ready && chatFallback("custom chat took too long to connect"), OWNCHAT_START_MS);
      const problem = await chatSigninProblem();
      if (turn !== chatTurn) return;
      if (problem) {
        clearTimeout(ownChatStartTimer);
        return showTwitchChat({ text: "Custom chat needs your OK on Twitch first.", label: "Sign in", run: ownChatSignIn });
      }
      const box = document.getElementById("live");
      box.replaceChildren();
      ownChat = window.OwnChat.start({
        box,
        me: MOCK ? { ...me, id: me.id || "1" } : me,
        channel: liveChannel,
        channelId: liveChannel === me.login ? (me.id || (MOCK ? "1" : "")) : "",
        token: chatToken,
        clientId: TWITCH_CLIENT_ID,
        urls: chatUrls(),
        isConnection: (login) => trusted().includes(login),
        onFail: (reason) => turn === chatTurn && chatFallback(reason),
        onChoose: chooseTwitchChat,
      });
      if (location.hostname === "localhost") window.__ownChat = ownChat;
      let lastTick = Date.now();
      ownChatWatch = setInterval(() => {
        try {
          const now = Date.now();
          const slept = now - lastTick > 20000;
          lastTick = now;
          if (slept) return;
          if (ownChat?.ready) clearTimeout(ownChatStartTimer);
          if (ownChat?.ready && now - ownChat.lastOk > OWNCHAT_SILENCE_MS) chatFallback("the connection to Twitch stopped");
        } catch {
          chatFallback("custom chat stopped responding");
        }
      }, 5000);
    } catch (err) {
      console.warn("Custom chat:", err);
      if (turn === chatTurn) chatFallback("custom chat couldn't start");
    }
  }

  function liveStart() {
    if (liveChannel) return;
    const wanted = (params.get("channel") || me.login).toLowerCase();
    if (!/^[a-z0-9_]+$/.test(wanted)) return;
    liveChannel = wanted;
    document.getElementById("live").hidden = false;
    chatBegin();
    liveSaid = get(`chatSaid-${wanted}`, {});
    liveBeen = get(`chatBeen-${wanted}`, liveBeen);
    setInterval(drawDots, Math.min(30 * 1000, LIGHT_MINUTE / 2)); // lights change with time
    if (DEMO) {
      // Here and chatting; here and lurking; came and left; never came (not shown).
      connections.push({ login: "leftearly", mutual: true, online: false }, { login: "nevercame", mutual: true, online: false });
      liveChatters.add("tallglassofwasps").add("techbuddy");
      liveSaid.tallglassofwasps = Date.now() - 2 * 60000;
      liveSaid.leftearly = Date.now() - 7 * 60000;
      liveBeen.logins = ["leftearly"];
      liveListed = true;
    } else {
      liveListen();
      setTimeout(liveRecheck, LIVE_RECHECK_MS);
      liveCheckStream();
      setInterval(liveCheckStream, 5 * 60 * 1000);
    }
    render();
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
    if (m.t === "status") {
      myStatus = m.status;
      render();
    } else if (m.t === "ask") gotQuestion({ id: `d${now}`, from: me.login, to: m.to, text: m.text, at: now, options: m.options, note: m.note, answer: null, dismissed: 0, seenAt: 0 });
    else if (m.t === "answer" && q) gotQuestion({ ...q, answer: { code: m.code, text: m.text, at: now } });
    else if (m.t === "dismiss" && q) gotQuestion({ ...q, dismissed: now });
    else if (m.t === "seen" && q) gotQuestion({ ...q, seenAt: now });
    else if (m.t === "nudge" && q && m.warn) gotQuestion({ ...q, warns: (q.warns || 0) + 1, warnedAt: now, nudgedAt: now });
    else if (m.t === "nudge" && q) gotQuestion({ ...q, nudges: Math.min(3, (q.nudges || 0) + 1), nudgedAt: now });
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
      rooms: [
        { owner: "you", tag: "Mods", members: [{ login: "you", online: true }, { login: "tallglassofwasps", online: true }] },
        { owner: "@tallglassofwasps+you", direct: true, with: "tallglassofwasps", members: [{ login: "tallglassofwasps", online: true }, { login: "you", online: true }] },
        { owner: "@techbuddy+you", direct: true, with: "techbuddy", members: [{ login: "techbuddy", online: false }, { login: "you", online: true }] },
      ],
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
      // Streamer View (side panel): what tallglassofwasps's OBS dock is showing.
      views: {
        tallglassofwasps: {
          glow: 3,
          chat: "livechat",
          waiting: [
            { id: "v1", from: "techbuddy", text: "Mic is peaking, can you turn it down?", at: now - 250000, note: false, stage: 3, top: 4, options: ["Yes", "No", "Soon"] },
            { id: "v2", from: "you", text: "Poll is ready when you are", at: now - 70000, note: true, stage: 1, top: 1, options: [] },
          ],
          answers: [{ id: "v3", to: "techbuddy", text: "Can you fix the overlay?", said: "Soon", code: "s", at: now - 40000 }],
          notes: [
            { id: "v4", kind: "chat", from: "you", text: "is this the speedrun category?", chatter: "NewViewer42", chatterColor: "#1e90ff", at: now - 30000 },
            { id: "v5", kind: "info", from: "techbuddy", text: "Raid incoming from dampeyes", at: now - 20000 },
          ],
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
    if (!question || !relay({ t: "ask", to: quickTo.value, text: question, ...askOrSay(question) })) return;
    rememberTo(quickTo.value);
    quickText.value = "";
    quickText.placeholder = "Sent ✓";
    setTimeout(() => (quickText.placeholder = "Message…"), 2500);
  });
  presenceBtn.addEventListener("click", () => openPresence(presenceMenu.hidden));
  // Sent from a popped-out window: the bar's picker follows.
  addEventListener("storage", (e) => {
    if (e.key === "lastTo" && me) rememberTo(get("lastTo", ""));
  });
  askFull.addEventListener("click", () => show("ask", quickTo.value));
  quickTo.addEventListener("change", drawQuick);
  // The dock being resized can change it between one row and full.
  addEventListener("resize", () => me && render());
  askBtn.addEventListener("click", () => {
    if (DECK) {
      view = "deck";
      return render();
    }
    if (short()) return show("ask");
    put("askOpen", true);
    view = "cards";
    render();
    document.querySelector('[data-key="ask"]')?.focus();
  });

  // A phone puts pages to sleep: reconnect as soon as it's back.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && me && !DEMO && !socket) connect();
  });

  let started = false;
  async function start() {
    if (DECK) document.body.classList.add("deck");
    if (POPOUT) document.body.classList.add("popout");
    if (EMBED) document.body.classList.add("embed");
    if (LIVECHAT) document.body.classList.add("livechat");
    if (DEMO) {
      askBtn.hidden = peopleBtn.hidden = false;
      startDemo();
      if (LIVECHAT) liveStart();
      if (PINGS_HERE) setInterval(() => pingCheck() && render(), 1000);
      return;
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
    if (LIVECHAT) liveStart();
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
    if (PINGS_HERE) setInterval(() => pingCheck() && render(), 1000);
  }

  start();
})();

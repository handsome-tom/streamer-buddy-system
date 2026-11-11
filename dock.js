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
//     chat. It receives everything but only sends messages and questions. The top bar
//     lists all your mods (lead mods first): glowing green while they're online, grayed
//     with a badge while they're not, a broken chain if they're not on Streamer Buddy yet;
//     once they're in the chat this stream, ringed green, orange, yellow, then white by
//     how recently they chatted. ?channel=<name> shows another channel's chat
// Everyone talks through the relay (relay/ in this repo, on Cloudflare): a
// WebSocket that signs in with your Twitch sign-in, keeps connections and the
// week's questions, and says who's online. Questions wait there for anyone
// who's offline.
//
// What's on screen:
//   - the top bar: one profile-picture dot per connection, ring glowing green while
//     they're online, faded until they've added you back. Something waiting
//     from someone makes their dot pulse in their Twitch chat color with a
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
//   "ids", "pics", "colors"  Twitch user ids, profile pictures, chat colors
//   "sound"    whether to make a sound when something arrives (on by default in OBS)
//   "pings"    what's been pinged, so a reload doesn't ping again
//   "lastTo"   who you last sent to, where sending starts from next time
//   "chatBeen-<channel>"  { stream, logins } who's been in the chat this stream
//
// Open with ?demo to try it without signing in. On this Mac, ?dev=<name> signs
// in as anyone against the local test relay.

(() => {
  // Signing in says who you are, and lets Twitch tell this page who your channel's mods are
  // and which channels you mod (for the Your mods / Channels I mod groups). Nothing else.
  const MOD_SCOPES = ["moderation:read", "user:read:moderated_channels"];
  const SCOPES = MOD_SCOPES.join(" ");
  // What sharing stream stats needs from Twitch (a streamer grants it once).
  const STATS_SCOPES = ["channel:read:subscriptions", "bits:read", "channel:read:ads", "channel:read:hype_train", "moderator:read:followers"];
  const SAMPLE_MS = 60 * 1000;
  const HELIX = "https://api.twitch.tv/helix";
  const MAX_LEN = 200;
  const UPDATE_CHECK_MS = 60 * 1000;
  // Twitch's sign-in sends the page back without its address options (?livechat, &ownchat,
  // &channel=...), so they're kept just before leaving and put back on the way in.
  const RETURN_KEY = "signinReturn";
  const backFromSignin = location.hash.includes("access_token") || /[?&]error=/.test(location.search);
  const params = new URLSearchParams((backFromSignin && localStorage.getItem(RETURN_KEY)) || location.search);
  const DEMO = params.has("demo");
  // The public demo (demo/index.html): the page is inside it, with a pretend relay and a
  // pretend Twitch running in the demo page and storage of its own (demo/sandbox.js), so it
  // behaves like testing on this Mac and never reaches the real relay or anyone's sign-in.
  const SANDBOX = params.has("sandbox") && window.parent !== window && !!window.SANDBOX_RELAY;
  const TESTING = location.hostname === "localhost" || SANDBOX;
  const DEV = TESTING ? params.get("dev") : null;
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
  // The streamer's answers, whatever the asker offered: heart, check, X and ? (maybe),
  // heart on the left. Anything else is a typed reply. The relay always accepts these.
  const STREAMER_ANSWERS = ["t", "y", "n", "m"];
  const answerChoices = (q) => (STREAMER ? STREAMER_ANSWERS.map((code) => ({ code, label: ANSWERS[code].label })) : optionsOf(q));
  // What an answer says: a typed reply or own option's words, else its label.
  const said = (a) => (a.code === "c" || a.code === "x" ? a.text : ANSWERS[a.code].label);

  const main = document.getElementById("main");
  const statusEl = document.getElementById("status");
  const dotsEl = document.getElementById("dots");
  const peekEl = document.getElementById("peek");
  const askBtn = document.getElementById("askBtn");
  const modBtn = document.getElementById("modBtn");
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
  const homeChatBtn = document.getElementById("homeChatBtn");
  const dndBtn = document.getElementById("dndBtn");
  // Do Not Disturb's icon: a middle finger, in pixels like the bar's other icons (also set
  // here, for a cached older index.html).
  const DND_HAND = '<svg class="px-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor" shape-rendering="crispEdges"><path d="M7 0h2v1h-2zM7 1h2v1h-2zM7 2h2v1h-2zM7 3h2v1h-2zM7 4h2v1h-2zM7 5h2v1h-2zM7 6h2v1h-2zM4 7h2v1h-2zM7 7h2v1h-2zM10 7h2v1h-2zM13 7h2v1h-2zM4 8h11v1h-11zM1 9h2v1h-2zM4 9h11v1h-11zM1 10h3v1h-3zM5 10h10v1h-10zM2 11h13v1h-13zM3 12h11v1h-11zM4 13h9v1h-9zM5 14h7v1h-7z"/></svg>';
  dndBtn?.querySelector("svg")?.replaceWith(Object.assign(document.createElement("template"), { innerHTML: DND_HAND }).content.firstChild);
  const dndLabel = document.getElementById("dndLabel");
  const chatCount = document.getElementById("chatCount");
  // Messages tab. Made here if this copy of index.html predates it (a browser can keep an
  // older page for a few minutes after an update, next to the newer dock.js).
  const msgBtn = document.getElementById("msgBtn") || (() => {
    const b = document.createElement("button");
    b.className = "pill pill--icon msg-btn";
    b.id = "msgBtn";
    b.type = "button";
    b.title = b.ariaLabel = "Messages";
    b.hidden = true;
    b.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor"><circle cx="12" cy="7.6" r="4.4"/><path d="M3.6 21.2c0-4.6 3.8-8 8.4-8s8.4 3.4 8.4 8z"/></svg><span class="pill__count" id="msgCount"></span>';
    document.getElementById("peopleBtn").before(b);
    return b;
  })();
  const msgCount = document.getElementById("msgCount");
  let chatFrom = ""; // "messages" when a chat was opened from Messages (its back button goes there)

  let me = null; // { login, id }
  // The side panel opens on Mod (the sword): the stream you're on.
  const HOME_VIEW = DECK ? "deck" : EMBED ? "mod" : "cards";
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
  let owner = null; // whose allow list decides who can sign in (everyone's first connection); null: anyone can
  let allowed = null; // the owner's own page only: [{ login, added, joined, used, limit }]
  let limit = null; // how many people you can add (your Top 8), when there's an owner
  let tags = {}; // { tag: [logins] } your own groups of connections (Mods, Lead mods, Tech…)
  let myStatus = "modding"; // how connections see you: "modding" (the default) | "online" | "idle" | "offline"
  let mySince = 0; // when you came online (from the relay)
  // Chat: the rooms you're in ({ owner, tag, members: [{ login, online }] }), and a
  // private chat with each mutual connection ({ owner, direct: true, with, members }),
  // and each one's recent messages ({ owner: [{ id, from, text, at }] }).
  let rooms = [];
  // Who's live on Twitch (checkLive, at most every 2 minutes each).
  const LIVE_CHECK_MS = 2 * 60 * 1000;
  const liveOf = {}; // login -> { live, at }
  const liveChecking = new Set();
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
  // Testing on localhost: the pretend users get pictures from dev/memes (kept out of git,
  // so only where someone's put them), so a ring glowing round a picture is easy to tell
  // from one that isn't. Never saved.
  if (DEV) {
    for (const who of SANDBOX ? ["streamer", "mod1", "mod2"] : ["streamer", "streamer2", "mod1", "mod2"]) {
      if (pics[who]) continue;
      const url = SANDBOX ? `demo/pics/${who}.png` : `/dev/memes/${who}.png`;
      fetch(url, { method: "HEAD" }).then((r) => r.ok && ((pics[who] = url), me && render())).catch(() => {});
    }
  }
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
          done: !!(q.answer || q.dismissed || q.withdrawn || (q.note && q.seenAt)), answered: q.answer, seenAt: q.seenAt, withdrawn: q.withdrawn,
          sending: !!pending[q.id], cleared: !!u.cleared, gone: !!u.gone,
        };
      } else if (q.from === me?.login) {
        sent[q.id] = {
          to: q.to, text: q.text, at: q.at, note: q.note, seenAt: q.seenAt, group: q.group, toTag: q.toTag, nudges: q.nudges || 0, nudgedAt: q.nudgedAt || 0, warns: q.warns || 0, warnedAt: q.warnedAt || 0, seen: !!u.waitClosed || !!q.dismissed || !!q.withdrawn, withdrawn: q.withdrawn, gone: !!u.gone,
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
  // Who sending starts with, everywhere (OBS, side panel, pop-outs, phone deck):
  //   1. whoever's stream you're in, if they're a connection (you're most likely their mod);
  //   2. else the last person you talked to (sent to or answered);
  //   3. else the first person.
  // Never a group or Everyone by default, so nothing goes to everyone by accident.
  const isPerson = (t) => t && t !== "*" && !t.startsWith("#");
  // The stream you're in: the channel open beside the side panel, or the chat dock's
  // channel when it's someone else's (in your own stream, it's the last person instead).
  function streamHere() {
    if (EMBED) return watching;
    if (LIVECHAT && me && liveChannel && liveChannel !== me.login) return liveChannel;
    return "";
  }
  function defaultTo() {
    const choices = targets();
    const here = streamHere();
    if (isPerson(here) && choices.includes(here)) return here;
    const last = get("lastTo", "");
    return choices.includes(last) && isPerson(last) ? last : choices.find(isPerson) || choices[0];
  }
  function rememberTo(to) {
    if (!isPerson(to)) return;
    put("lastTo", to);
    if ([...quickTo.options].some((o) => o.value === to)) quickTo.value = to;
  }
  // Walked into someone's stream: sending follows (until you pick someone else).
  function followStream() {
    const here = streamHere();
    if (!me || !isPerson(here) || !targets().includes(here)) return;
    askDraft.to = here;
    deckState.to = here;
    if ([...quickTo.options].some((o) => o.value === here)) quickTo.value = here;
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

  // The side panel shows the connection glow in its bottom-right corner instead, on
  // every screen (dock.css, .conn-glow).
  const connGlow = EMBED ? document.body.appendChild(el("div", "conn-glow")) : null;
  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.parentElement.title = text; // the glow can't be hovered, so the bar says it
    statusEl.className = `bar__status${kind ? ` bar__status--${kind}` : ""}`;
    if (connGlow) connGlow.className = `conn-glow${text && kind ? ` bar__status--${kind}` : ""}`;
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

  function bounceTom(space) {
    // A little meteor: the head (spinning) with a faint lunar glow and crater texture, and a
    // faint tail trailing behind whichever way it drifts.
    const tom = el("span", "space__tom");
    const tail = el("span", "space__tail");
    const rock = el("span", "space__rock");
    const face = el("img", "space__face");
    face.src = "icons/tom.png";
    face.alt = "";
    rock.append(face, el("span", "space__craters"));
    tom.append(tail, rock);
    space.append(tom);
    const SIZE = 50; // matches .space__tom
    const SPEED = 22; // pixels a second
    let x = Math.random() * Math.max(0, innerWidth - SIZE);
    let y = Math.random() * Math.max(0, innerHeight - SIZE);
    let dx = Math.random() < 0.5 ? -1 : 1;
    let dy = Math.random() < 0.5 ? -1 : 1;
    const SPIN = 18; // degrees a second; it turns the other way after each bounce
    let turn = 180; // starts upside down
    let spin = Math.random() < 0.5 ? -1 : 1;
    const place = () => {
      tom.style.transform = `translate(${x}px, ${y}px)`;
      rock.style.transform = `rotate(${turn}deg)`;
      tail.style.transform = `rotate(${(Math.atan2(-dy, -dx) * 180) / Math.PI}deg)`; // points back the way it came
    };
    place();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let last = 0;
    const step = (now) => {
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      const maxX = Math.max(0, innerWidth - SIZE);
      const maxY = Math.max(0, innerHeight - SIZE);
      x += dx * SPEED * dt;
      y += dy * SPEED * dt;
      turn = (turn + spin * SPIN * dt) % 360;
      if (x <= 0 || x >= maxX) { dx = x <= 0 ? 1 : -1; x = Math.min(Math.max(x, 0), maxX); spin = -spin; }
      if (y <= 0 || y >= maxY) { dy = y <= 0 ? 1 : -1; y = Math.min(Math.max(y, 0), maxY); spin = -spin; }
      place();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
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
      scope: get("statsWanted", false) ? [...STATS_SCOPES, ...MOD_SCOPES].join(" ") : SCOPES,
      state,
    });
    localStorage.setItem(RETURN_KEY, location.search);
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
      scope: [...window.OwnChat.SCOPES, ...(window.OwnChat.EXTRA_SCOPES || [])].join(" "), // extras: nice to have, not needed
      state,
    });
    localStorage.setItem(RETURN_KEY, location.search);
    location.href = `https://id.twitch.tv/oauth2/authorize?${q}`;
  }

  // The phone deck: Twitch shows nothing here; you enter a code at
  // twitch.tv/activate (on this phone or anything else) and this waits for it.
  // It comes with a refresh token, so the sign-in renews itself.
  const TWITCH_TOKEN = "https://id.twitch.tv/oauth2/token";
  const form = (o) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o) });

  async function codeSignIn() {
    const scopes = get("statsWanted", false) ? [...STATS_SCOPES, ...MOD_SCOPES].join(" ") : SCOPES;
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
    const said = new URLSearchParams(location.search); // what Twitch put in the address (params is the kept one)
    const state = h.get("state") || said.get("state");
    // Custom chat's sign-in can ban and delete, so it's kept apart from the ordinary one,
    // which is the one that goes to the relay.
    if (state && state === get("signinState") && h.get("access_token")) put(state.endsWith("-ownchat-livechat") ? "chatToken" : "token", h.get("access_token"));
    localStorage.removeItem("signinState");
    // Back to the address it had before signing in (or a plain one if that's gone).
    const back = localStorage.getItem(RETURN_KEY);
    localStorage.removeItem(RETURN_KEY);
    const kept = new URLSearchParams(back || "");
    kept.delete("state");
    kept.delete("error");
    kept.delete("error_description");
    const query = back ? kept.toString().replace(/=(?=&|$)/g, "") : EMBED ? "embed=ext" : LIVECHAT ? "livechat" : "";
    history.replaceState(null, "", location.pathname + (query ? `?${query}` : ""));
    if (said.get("error")) return said.get("error_description") || said.get("error");
  }

  // The extension (our parent page) handing over a sign-in.
  addEventListener("message", (e) => {
    // StreamerSpace's settings, from the extension's side panel (or the demo page).
    if (EMBED && e.source === parent && (String(e.origin).startsWith("chrome-extension://") || (SANDBOX && e.origin === location.origin))) gotExt(e.data);
    if (!EMBED || e.source !== parent || !String(e.origin).startsWith("chrome-extension://")) return;
    if (e.data?.t === "hub-token" && typeof e.data.token === "string") {
      put("token", e.data.token);
      start();
    }
    // The Twitch channel open in the tab beside the panel, for Streamer View.
    if (e.data?.t === "hub-channel") {
      watching = typeof e.data.channel === "string" ? e.data.channel.toLowerCase() : "";
      tabChannel = watching;
      // The Ask box follows the stream you're in (until you pick someone else).
      followStream();
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

  // ===== Mod groups from Twitch ==========================================================
  // Twitch Space is for streamers and mods alike, so two groups fill themselves in:
  //   "Your mods":       your channel's moderators (when you stream);
  //   "Channels I mod":  the streamers you moderate for (when you mod).
  // They're ordinary groups (tags) underneath, so Message group works as usual; this keeps
  // them matching Twitch for everyone you're connected with. Mods you aren't connected with
  // yet are listed on the group too, with an Add button. Refreshed every 10 minutes.
  const AUTO_GROUPS = { mods: "Your mods", modFor: "Channels I mod" };
  const MOD_LISTS_EVERY_MS = 10 * 60 * 1000;
  let modLists = null; // { mods: [logins], modFor: [logins] } once Twitch has said
  let modListsAt = 0;
  const hasModScopes = () => !!me && MOD_SCOPES.every((sc) => me.scopes?.includes(sc));
  const isAutoGroup = (tag) => Object.values(AUTO_GROUPS).includes(tag);

  async function helixAll(path, pick) {
    const out = [];
    let after = "";
    for (let page = 0; page < 10; page++) {
      const r = await helix(`${path}&first=100${after ? `&after=${encodeURIComponent(after)}` : ""}`);
      if (!r.ok) throw new Error(`Twitch said ${r.status}`);
      const j = await r.json();
      out.push(...(j.data || []).map(pick).filter(Boolean));
      after = j.pagination?.cursor || "";
      if (!after) break;
    }
    return out.map((l) => l.toLowerCase());
  }

  async function loadModLists(force = false) {
    if (!me || (!force && Date.now() - modListsAt < MOD_LISTS_EVERY_MS)) return;
    modListsAt = Date.now();
    // On this Mac and in the demo: pretend lists from the address (?mods=a,b&modfor=c).
    if (TESTING) {
      modLists = { mods: (params.get("mods") || "").split(",").filter(Boolean), modFor: (params.get("modfor") || "").split(",").filter(Boolean) };
    } else {
      if (!me.id || !hasModScopes()) return;
      try {
        const [mods, modFor] = await Promise.all([
          helixAll(`/moderation/moderators?broadcaster_id=${me.id}`, (d) => d.user_login),
          helixAll(`/moderation/channels?user_id=${me.id}`, (d) => d.broadcaster_login),
        ]);
        modLists = { mods, modFor };
      } catch {
        modListsAt = 0; // try again next time
        return;
      }
    }
    loadPics(); // pictures for the channels you mod too (Mod view's top bar)
    syncModGroups();
    render();
  }

  // Keep the two groups matching Twitch, for the people you're connected with.
  const tagSent = new Set(); // "tag|login|on" already asked for, so nothing's sent twice
  function syncModGroups() {
    if (!modLists || !ready) return;
    const known = new Set([...connections.map((c) => c.login)]);
    for (const [key, tag] of Object.entries(AUTO_GROUPS)) {
      const want = new Set(modLists[key].filter((l) => known.has(l)));
      const have = new Set(tags[tag] || []);
      for (const login of want) if (!have.has(login)) sendTag(tag, login, true);
      for (const login of have) if (!want.has(login) && !modLists[key].includes(login)) sendTag(tag, login, false);
    }
  }
  function sendTag(tag, login, on) {
    const k = `${tag}|${login}|${on}`;
    if (tagSent.has(k)) return;
    tagSent.add(k);
    setTimeout(() => tagSent.delete(k), 60 * 1000);
    relay({ t: "tag", login, tag, on });
  }

  // ===== Twitch API (pictures, colors, checking a name) ===================================

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

  // Profile pictures and chat colors for the dots, once per load (people change them).
  let picsFor = "";
  async function loadPics() {
    const logins = [...new Set([me?.login, ...trusted(), ...requests, ...(modLists?.modFor || []), ...(modLists?.mods || [])].filter(Boolean))]; // you too: your color tints your bookmarks
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

  // Black or white, whichever reads better on a color.
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
      else if (m.t === "unflash") {
        heldFlashes.delete(m.id); // taken back while it waited out Do Not Disturb: it never shows
        (pinLeaving.get(m.id) || flashLeaving.get(m.id))?.();
      }
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
      if (e.code === 4003) {
        showSignedOut(`StreamerSpace is invite-only for now, and you're not on the list yet.${notAllowedBy ? ` Ask ${notAllowedBy} to add you.` : ""}`);
        return;
      }
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
    if ("owner" in m) owner = m.owner || null;
    allowed = m.allowed || null;
    limit = m.limit || null;
    if (first) setTimeout(() => onlineNow() || spinPresence(), 400);
    connections = m.connections || [];
    requests = m.requests || [];
    tags = m.tags || {};
    setTimeout(() => (modLists ? syncModGroups() : loadModLists()), 0);
    rooms = m.rooms || [];
    chat = m.chat || {};
    stats = m.stats || {};
    views = m.views || (DEMO ? views : {});
    lastView = ""; // a fresh connection: the relay hears this dock's view again
    statsOn = !!m.statsOn;
    myStatus = m.status || myStatus;
    mySince = m.since || mySince;
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
  //
  // In the streamer's chat dock the pin only sticks at the top of the chat for
  // PIN_STICK_MS, and the line itself glows in the chat (custom chat), so it's easy to
  // find again without taking up the top for long.
  const FLASH_MS = { info: 120000, chat: 300000, love: 30000, seen: 5000 }; // "Seen" is just a quick tick
  const PIN_STICK_MS = 10 * 1000;
  const flashMs = (kind) => (kind === "chat" && LIVECHAT ? PIN_STICK_MS : FLASH_MS[kind]);
  const FUZZ_MS = 1400;
  const FLASH_ICONS = {
    info: `<path d="M11 2 4 11.5h5L8 18l7-9.5h-5z" ${LINE} stroke-width="1.7"/>`,
    // !vanish: a little devil face (horns, sly brows, grin), like the 😈.
    love: `<path d="M5.2 7.6 4 3.2l3.6 2.4M14.8 7.6 16 3.2l-3.6 2.4" ${LINE} stroke-width="1.7"/><circle cx="10" cy="11.2" r="6" ${LINE} stroke-width="1.7"/><path d="M6.9 9.3l2.1 1.1M13.1 9.3 11 10.4" ${LINE} stroke-width="1.7"/><path d="M7.1 13.1q2.9 2.7 5.8 0" ${LINE} stroke-width="1.7"/>`,
    chat: `<path d="M3 4h14v9H8l-4 3v-3H3z" ${LINE} stroke-width="1.8"/>`,
    seen: `<path d="M4 10.5l4 4 8-9" ${LINE} stroke-width="2.4"/>`,
  };
  const seenFlashes = new Set();
  const pinLeaving = new Map(); // pinned line's id -> takes it away
  const flashLeaving = new Map(); // a quick note's or !vanish's id -> takes it away (its sender took it back)
  // Do Not Disturb: quick info and !vanish notes wait here, and show (with their full time
  // on screen) once it's over. A "Seen" tick isn't worth waiting for, so it's dropped.
  const heldFlashes = new Map(); // id -> the note
  function releaseFlashes() {
    if (dndOn() || !heldFlashes.size) return;
    const notes = [...heldFlashes.values()];
    heldFlashes.clear();
    for (const f of notes) gotFlash({ ...f, at: Date.now(), released: true });
    if (notes.some((f) => f.kind === "info")) arrived(); // one glow and chime for what waited
  }

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
    if (mine && dndOn() && f.kind !== "chat") {
      if (f.kind !== "seen") heldFlashes.set(f.id, f);
      return;
    }
    seenFlashes.add(f.id);
    const late = Date.now() - (f.at || Date.now());
    if (f.kind === "chat" && LIVECHAT && f.channel === liveChannel) {
      try {
        ownChat?.glowLine?.({ chatter: f.chatter, text: f.text, color: f.color || colorOf(f.from) });
      } catch {}
      if (late > PIN_STICK_MS) return; // brought back by a reload: its moment at the top has passed
    }
    // A love note and a "Seen" come in quietly; not when a reload brings back an old pin.
    if (f.kind !== "love" && f.kind !== "seen" && mine && late < 5000 && !f.released) arrived();
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
    } else if (LIVECHAT) {
      // The chat dock shows these as big as a question: who first, in their color.
      const who = el("b", "qflash__from", f.from);
      if (colorOf(f.from)) who.style.color = colorOf(f.from);
      body.append(who, " ", document.createTextNode(f.text), ...(f.kind === "love" ? [el("span", "qflash__who", "  !vanish")] : []));
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
      flashLeaving.delete(f.id);
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
    else flashLeaving.set(f.id, leave);
    (pinned && (LIVECHAT || !short()) ? pinsEl : flashesEl).append(chip);
    setTimeout(leave, Math.max(0, flashMs(f.kind) - FUZZ_MS - Math.max(0, late)));
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

  let notAllowedBy = ""; // who to ask, when the relay turned this sign-in away

  // Your Top 8 is full: Tom pops up to say so (the relay refused the add).
  function showTopEight(n) {
    document.querySelector(".top8")?.remove();
    const shade = el("div", "top8");
    const box = el("div", "top8__box");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Your Top 8 is full");
    const face = el("img", "top8__tom");
    face.src = "icons/tom.png";
    face.alt = "";
    const close = () => {
      shade.remove();
      removeEventListener("keydown", onKey);
    };
    const onKey = (e) => e.key === "Escape" && close();
    addEventListener("keydown", onKey);
    shade.addEventListener("click", (e) => e.target === shade && close());
    box.append(face, el("div", "top8__head", n === 8 ? "You've filled your Top 8!" : `You've filled all ${n} of your spots!`),
      el("p", "top8__words", "Message MyspaceTomOfficial on Discord, and your list can be extended."));
    // The Discord name, with a button to copy it.
    const tag = el("div", "top8__discord");
    tag.append(el("span", "top8__dlabel", "Discord"), el("b", "top8__dname", TOM_DISCORD_NAME));
    box.append(tag);
    const row = el("div", "top8__btns");
    const copy = el("button", "cx__btn cx__btn--blue", "Copy Discord name");
    copy.type = "button";
    copy.addEventListener("click", () => {
      navigator.clipboard?.writeText(TOM_DISCORD_NAME).then(() => (copy.textContent = "Copied!"), () => (copy.textContent = "Couldn't copy"));
    });
    row.append(copy);
    const ok = el("button", "cx__btn", "OK");
    ok.type = "button";
    ok.addEventListener("click", close);
    row.append(ok);
    box.append(row);
    shade.append(box);
    document.body.append(shade);
    ok.focus();
  }
  function gotError(m) {
    for (const k of Object.keys(pending)) delete pending[k];
    nudging.clear();
    if (m.why === "signin") return; // the socket closing next deals with it
    if (m.why === "notallowed") return void (notAllowedBy = m.owner || ""); // closing next, too
    if (m.why === "topeight") return showTopEight(m.limit || limit || 8);
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
    if (dndOn()) return; // Do Not Disturb: it waits, quietly
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
    if (!POPOUT && soundOn() && !dndOn()) tones([659, 880], 0.14, 0.18 * vol(), 0.35);
  }
  // Something new: one clear note. A reminder (it moved up a color): one softer note,
  // unless reminders are switched off in Settings.
  // A warning: two quick, higher notes, a little louder (even with reminders off).
  function ping(stage) {
    if (!soundOn() || dndOn()) return;
    if (stage === PING_WARN) return tones([1319, 1319], 0.16, 0.26 * vol(), 0.14);
    if (stage > 1 && !get("reminderBeeps", true)) return;
    tones([988], 0, (stage > 1 ? 0.13 : 0.22) * vol(), 0.22);
  }

  // ===== Pings =============================================================================
  // Someone needs the streamer. The edge of the panel glows (a thin, faint line), over
  // whichever chat is showing. Everything arrives green, with one clear note. If it isn't
  // answered, the person who asked can nudge it (q.nudges): each nudge moves it up a
  // color (orange, yellow, then white) with one softer note and a brief flash of the
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
  let glowNow = 0; // the edge's color right now (0 = no glow), for Streamer View

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
    // Something new (or up a color): glow up now and start the 15-second cycle again,
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
  let watching = (TESTING && params.get("watch")?.toLowerCase()) || "";
  // The same, but never cleared by picking someone by hand: for "On this stream".
  let tabChannel = watching;
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
    return { glow: dndOn() ? 0 : glowNow, waiting, answers, notes, chat: LIVECHAT ? "livechat" : "dock", dnd: dndOn() ? get("dndUntil", 0) : 0, leads: get("leads", []) };
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
    // The sword's ring, or sword ↔ hammer (they're the streamer's lead mod), changed.
    if (EMBED && (modBtn.classList.contains("mod-btn--live") !== modRinged() || modBtn.dataset.icon !== modIcon())) render();
  }

  // Whose view the panel shows.
  // Lead moderators: Twitch doesn't say who they are anywhere but their chat badge, so the
  // streamer's own chat dock remembers whoever chats with "lead_moderator" in their own
  // channel ("leads", kept here) and shares the list with Streamer View. A lead mod's side
  // panel then shows the hammer in place of the sword. (Twitch lets a lead mod show the
  // plain mod badge instead; then they stay a sword until they chat with the lead one.)
  function noteLead(login, ranks) {
    if (!me || liveChannel !== me.login || !login) return;
    const leads = get("leads", []);
    if (!ranks.includes("lead_moderator") || leads.includes(login)) return;
    put("leads", [...leads, login].slice(-12));
    shareView();
  }
  const SWORD_ICON = `<svg viewBox="-0.5 -0.5 21 21" width="16" height="16" aria-hidden="true">${'<path fill="#fff" fill-rule="evenodd" d="M19.4 0.6 L13.8 1.6 L5.4 12.8 L7.2 14.6 L18.4 6.2 Z M15.4 4.6 L6.75 12.85 L7.15 13.25 Z"/><g stroke="#fff" stroke-linecap="round" fill="none"><path d="M3.5 12.3 L7.7 16.5" stroke-width="1.8"/><path d="M5.6 14.4 L2.4 17.6" stroke-width="1.5"/></g><circle cx="1.5" cy="18.5" r="1.3" fill="#fff"/>'}</svg>`;
  const HAMMER_ICON = `<svg viewBox="-0.5 -0.5 21 21" width="16" height="16" aria-hidden="true">${'<path fill="#fff" stroke="#fff" stroke-width="0.5" stroke-linejoin="round" d="M10.32 1.48 L12.79 3.95 L12.87 5.15 L14.85 7.13 L16.05 7.21 L18.52 9.68 L14.28 13.92 L11.81 11.45 L11.73 10.25 L9.75 8.27 L8.55 8.19 L6.08 5.72 Z"/><path d="M10.18 9.82 L2.68 17.32" stroke="#fff" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M14.42 5.58 L15.34 4.66" stroke="#fff" stroke-width="1.7" stroke-linecap="round" fill="none"/>'}</svg>`;
  const isLeadFor = (owner) => !!(me && views[owner]?.leads?.includes(me.login));

  // Whose stream Mod is about: the channel you're watching when they're a connection, else
  // the one picked by hand, else a channel you mod, else whoever shares a view. Your thread
  // with each streamer is the same one wherever you are; flipping streams flips to theirs.
  function modOwner() {
    if (!me) return "";
    const able = connections.filter((c) => c.mutual).map((c) => c.login);
    if (watching && able.includes(watching)) return watching;
    const modFor = modLists?.modFor || [];
    if (able.includes(svPicked) || modFor.includes(svPicked)) return svPicked;
    const sharing = Object.keys(views).filter((l) => l !== me.login);
    return able.find((l) => modFor.includes(l)) || able.find((l) => sharing.includes(l)) || able[0] || "";
  }

  // The X on your own things in Streamer View: takes it off their dock. It's gone from the
  // list as soon as their dock says so (a moment later).
  function takeBack(send, what) {
    const x = closeButton((e) => {
      e.stopPropagation();
      x.disabled = true;
      x.closest(".sv__row")?.classList.add("sv__row--going");
      send();
    }, `Take back your ${what} (removes it from their dock)`);
    x.classList.add("sv__x");
    return x;
  }

  // The chat page fills exactly the room left below whatever's above it (the bar, Streamer
  // View, the chat dock's own top), so its box to type in always sits at the bottom with
  // no scrolling; the history above takes what's left, newest at the bottom.
  function fitChat() {
    const panel = view === "chat" && main.querySelector(".panel.chat");
    if (!panel) return;
    const log = panel.querySelector(".chat__log");
    const atEnd = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 40 || !log.dataset.fitted;
    let bottom = window.innerHeight; // the side panel: the page is the screen
    let top = panel.getBoundingClientRect().top + window.scrollY;
    if (LIVECHAT) {
      // The chat dock: what opens under the bar is capped (max-height), over Twitch chat.
      const box = main.getBoundingClientRect();
      bottom = box.top + (parseFloat(getComputedStyle(main).maxHeight) || window.innerHeight);
      top = panel.getBoundingClientRect().top + main.scrollTop;
    }
    const pad = parseFloat(getComputedStyle(main).paddingBottom) || 0;
    panel.style.height = `${Math.max(180, Math.floor(bottom - top - pad - 2))}px`;
    if (log) {
      log.dataset.fitted = "1";
      if (atEnd) log.scrollTo(0, 1e9);
    }
  }
  window.addEventListener("resize", fitChat);

  // ===== Do Not Disturb (the streamer's OBS docks) =========================================
  // Clicking the hand offers a choice: for 15 minutes, or until it's clicked off. Meanwhile
  // no sounds, no glowing edge and no message card; things still arrive and wait, and show
  // once it's over. Clicking it while it's on ends it. Connections see it in Streamer View.
  // Kept on this device ("dndUntil": a time, or -1 for until turned off), so every dock on
  // it agrees.
  const DND_MS = 15 * 60 * 1000;
  const DND_FOREVER = -1;
  const dndOn = () => {
    const until = get("dndUntil", 0);
    return until === DND_FOREVER || until > Date.now();
  };
  const dndMenu = document.getElementById("dndMenu");
  function setDnd(until) {
    put("dndUntil", until);
    openDndMenu(false);
    drawDnd();
    pingCheck();
    render();
  }
  function openDndMenu(open) {
    dndMenu.hidden = !open;
    dndBtn.setAttribute("aria-expanded", String(open));
    if (!open) return;
    const pick = (label, sub, until) => {
      const b = el("button", "dnd-menu__item");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.append(el("b", null, label), el("span", null, sub));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        setDnd(until());
      });
      return b;
    };
    dndMenu.replaceChildren(
      el("div", "dnd-menu__head", "Do Not Disturb"),
      pick("For 15 minutes", "Then everything comes back by itself", () => Date.now() + DND_MS),
      pick("Until I turn it off", "Click the hand again to end it", () => DND_FOREVER),
    );
    // Right under the hand (over the message box below it if need be), its right edge
    // lined up with the hand's, kept on screen.
    const bar = dndMenu.offsetParent || document.body;
    const at = dndBtn.getBoundingClientRect();
    const box = bar.getBoundingClientRect();
    const width = dndMenu.offsetWidth;
    dndMenu.style.top = `${at.bottom - box.top + 4}px`;
    dndMenu.style.right = "auto";
    dndMenu.style.left = `${Math.max(4, Math.min(at.right - box.left - width, box.width - width - 4))}px`;
  }
  document.addEventListener("click", (e) => !dndMenu.hidden && !dndMenu.contains(e.target) && openDndMenu(false));
  document.addEventListener("keydown", (e) => e.key === "Escape" && !dndMenu.hidden && openDndMenu(false));
  function drawDnd() {
    const on = dndOn();
    const until = get("dndUntil", 0);
    dndBtn.hidden = !PINGS_HERE || !me;
    document.body.classList.toggle("dnd", on);
    dndBtn.classList.toggle("pill--on", on);
    dndBtn.classList.toggle("dnd-btn--on", on);
    dndBtn.setAttribute("aria-pressed", String(on));
    const left = on && until !== DND_FOREVER ? Math.ceil((until - Date.now()) / 60000) : 0;
    dndLabel.textContent = !on ? "" : left ? `${left}m` : "On";
    dndBtn.title = !on ? "Do Not Disturb" : left ? `Do Not Disturb: ${left} min left. Click to turn it off now` : "Do Not Disturb until you turn it off. Click to turn it off now";
  }
  let dndWas = false;
  setInterval(() => {
    if (!me) return;
    const on = dndOn();
    if (on !== dndWas) {
      dndWas = on;
      render(); // it ended by itself (or another dock changed it): show what waited
      releaseFlashes();
    } else drawDnd();
  }, 1000);
  window.addEventListener("storage", (e) => e.key?.endsWith("dndUntil") && render());

  const svEl = document.getElementById("streamerView");
  function drawStreamerView() {
    if (!svEl) return;
    // Shown inside Mod only, for the streamer it's about (when their dock shares a view).
    const modFor = EMBED && me && view === "mod" ? modOwner() : "";
    const owner = views[modFor] ? modFor : "";
    svEl.hidden = !owner;
    if (!owner) return svEl.replaceChildren();
    const v = views[owner];
    const open = get("svOpen", true);
    svEl.className = `sv${v.glow ? ` sv--glow sv--${v.glow}` : ""}${open ? "" : " sv--closed"}`;

    const head = el("div", "sv__head");
    const toggle = el("button", "sv__toggle");
    toggle.type = "button";
    toggle.title = open ? "Fold Streamer View away" : "Show Streamer View";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.append(el("span", "sv__title", "Their feed"));
    const count = v.waiting.length;
    const dndLeft = v.dnd > Date.now() ? Math.ceil((v.dnd - Date.now()) / 60000) : 0;
    const dnd = v.dnd === -1 ? "Do Not Disturb" : dndLeft ? `Do Not Disturb · ${dndLeft} min` : "";
    const says = dnd ? `${dnd}${count ? ` · ${count} waiting` : ""}` : v.glow ? `Glowing ${PING_NAMES[v.glow].toLowerCase()}` : count ? `${count} waiting` : "Nothing waiting";
    if (v.glow) toggle.append(el("span", `peek__ping peek__ping--${v.glow}`));
    toggle.append(el("span", "sv__says", says));
    toggle.addEventListener("click", () => {
      put("svOpen", !open);
      drawStreamerView();
    });
    head.append(toggle);
    if (!open) {
      svEl.replaceChildren(head);
      return fitChat();
    }

    const body = el("div", "sv__body");
    const who = (login) => {
      const b = el("b", "sv__who", login);
      if (colorOf(login)) b.style.color = colorOf(login);
      return b;
    };
    // Each line: a mark (dot or icon), who and when on top, what was said under it, and
    // your own actions (Nudge, take back) as small round buttons on the right.
    const line = (cls, mark, whoLogin, verb, at, text, extra) => {
      const row = el("div", `sv__row ${cls}`);
      row.append(mark);
      const main = el("div", "sv__main");
      const meta = el("div", "sv__meta");
      const mine = whoLogin === me.login;
      const name = el("b", "sv__who", mine ? "You" : whoLogin || "");
      if (!mine && colorOf(whoLogin)) name.style.color = colorOf(whoLogin);
      meta.append(name, el("span", "sv__verb", mine ? { asks: "asked", says: "said" }[verb] || verb : verb));
      if (at) meta.append(el("span", "sv__ago", ago(at)));
      main.append(meta, el("div", "sv__text", text));
      if (extra) main.append(el("div", "sv__muted sv__extra", extra));
      row.append(main);
      const acts = el("div", "sv__acts");
      row.append(acts);
      body.append(row);
      return acts;
    };
    for (const q of v.waiting) {
      const dot = el("span", `peek__ping peek__ping--${q.stage || 0}${q.stage ? "" : " sv__dot--quiet"} sv__mark`);
      const acts = line(`sv__row--${q.stage || 0}`, dot, q.from, q.note ? "says" : "asks", q.at, q.text, q.nudges ? `Nudged ${q.nudges}×` : "");
      // Your own unanswered question: nudge it from here too, or take it back.
      if (q.from === me.login && sent[q.id] && !q.note) {
        const nb = nudgeButton([q.id]);
        nb.insertAdjacentHTML("beforeend", '<svg class="sv__bell" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>');
        nb.setAttribute("aria-label", nb.textContent.trim() || "Nudge");
        acts.append(nb);
      }
      if (q.from === me.login && sent[q.id]) acts.append(takeBack(() => relay({ t: "withdraw", id: q.id }), q.note ? "message" : "question"));
    }
    for (const a of v.answers) {
      const icon = el("span", `peek__icon answer--${a.code} sv__mark`);
      icon.innerHTML = svg((ANSWERS[a.code] || ANSWERS.c).icon, 13);
      line("sv__row--answer", icon, a.to, `answered ${a.said}`, a.at, a.text);
    }
    for (const f of v.notes) {
      const icon = el("span", "sv__icon sv__mark");
      icon.innerHTML = svg(FLASH_ICONS[f.kind] || FLASH_ICONS.info, 13);
      const cls = `sv__note sv__note--${f.kind}`;
      let acts;
      if (f.kind === "chat") {
        const chatter = el("span");
        const n = el("b", null, f.chatter || "");
        if (f.chatterColor) n.style.color = f.chatterColor;
        chatter.append(n, `: ${f.text}`);
        acts = line(cls, icon, f.from, "flagged a line", f.at, "", "");
        acts.previousElementSibling.querySelector(".sv__text").replaceChildren(chatter);
      } else if (f.kind === "seen") {
        acts = line(cls, icon, f.from, "saw", f.at, f.text);
      } else {
        acts = line(cls, icon, f.from, f.kind === "love" ? "!vanish" : "quick info", f.at, f.text);
      }
      if (f.color && f.kind !== "love" && f.kind !== "seen") acts.parentElement.style.setProperty("--c", f.color);
      // Yours: take it off their bar (a flagged line comes off for everyone who has it).
      if (f.from === me.login && f.kind !== "seen") acts.append(takeBack(() => relay({ t: "unflash", id: f.id }), f.kind === "chat" ? "flagged line" : f.kind === "love" ? "!vanish" : "note"));
    }
    if (!body.childElementCount) body.append(el("p", "sv__empty", "Their dock is clear: nothing waiting."));
    svEl.replaceChildren(head, body);
    fitChat(); // it's above the chat page, so the chat's room changes with it
  }
  // Ages ("2 min ago") move on even when nothing new arrives.
  if (EMBED) setInterval(() => !svEl?.hidden && drawStreamerView(), 30000);

  // ===== Settings ==========================================================================
  // The gear at the top right of the streamer's OBS docks. Each is kept in this page's
  // localStorage, so OBS keeps it between restarts:
  //   "sound"          sound when something arrives (also under Connections)
  //   "volume"         "quiet" | "normal" | "loud"
  //   "reminderBeeps"  the softer note each time something waiting moves up a color
  //   "edgeGlow"       the thin line round the edge
  //   "showQuick"      the quick-questions row (chat dock)
  //   "chatSize"       "small" | "normal" | "large": custom chat's text (chat dock)
  //   "shareView"      send Streamer View to your connections
  //   "modIcons"       ban / time out / delete icons before names in custom chat
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsEl = document.getElementById("settings");
  // The chat dock's bar clips what hangs below it (it's kept to its own rounded glass), so
  // there its two menus live on the page itself, pinned just under the bar.
  if (LIVECHAT) {
    document.body.append(settingsEl, dndMenu);
    settingsEl.classList.add("float-menu");
    dndMenu.classList.add("float-menu");
  }

  // What the switches change on screen, applied on load and on every change.
  function applySettings() {
    document.body.classList.toggle("no-edge", !get("edgeGlow", true));
    document.body.classList.toggle("hide-quick", !get("showQuick", true));
    document.body.classList.toggle("no-modicons", !get("modIcons", true));
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
    parts.push(sw("sound", "Notification sounds", PINGS_HERE, (on) => on && ping(1)));
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
      if (get("ownChat", true) && window.OwnChat) {
        const twitch = get("ownChatPicked", "") === "twitch";
        parts.push(choice("Chat", [["own", "Custom"], ["twitch", "Twitch's"]], twitch ? "twitch" : "own", (v) => {
          if (v === "twitch" && !twitch) chooseTwitchChat();
          else if (v === "own" && twitch) backToOwnChat();
        }));
        parts.push(choice("Chat text", [["small", "Small"], ["normal", "Normal"], ["large", "Large"]], get("chatSize", "normal"), (v) => put("chatSize", v)));
        parts.push(sw("modIcons", "Mod icons next to names (ban, time out, delete)", true));
      }
    }

    parts.push(head("Mods"));
    parts.push(sw("shareView", "Share what this dock shows (Streamer View)", true, () => {
      lastView = ""; // send the change straight away
      shareView();
    }));
    parts.push(el("p", "set__note", "Your connections see it at the top of their Chrome side panel."));
    const brand = el("div", "set__brand");
    const mark = el("img", "set__brandmark");
    mark.src = "icons/ts-mark.svg";
    mark.alt = "";
    brand.append(mark, el("span", null, "StreamerSpace"), el("span", "set__brandbuild", `Build ${window.DOCK_VERSION || "?"}`));
    parts.push(brand);
    settingsEl.replaceChildren(...parts);
  }

  function openSettings(open) {
    settingsEl.hidden = !open;
    if (open && LIVECHAT) {
      const below = Math.round(document.querySelector(".bar").getBoundingClientRect().bottom + 4);
      settingsEl.style.top = `${below}px`;
      settingsEl.style.maxHeight = `${Math.max(160, innerHeight - below - 8)}px`;
    }
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
    if (next !== "chat") chatFrom = next === "messages" ? "messages" : "";
    if (next === "stats" && to) statsDraft.who = to;
    if (next === "ask" || next === "person") {
      askDraft.to = to || askDraft.to;
      askDraft.note = "";
    }
    if (next !== "cards" && short() && popOut(next, to)) return;
    showAll = false;
    const was = view;
    view = view === next && next !== "person" ? HOME_VIEW : next;
    render();
    if (view !== was || next === "chat") main.scrollTop = 0; // a new page starts at its top
  }

  // ===== Drawing ===========================================================================

  function render() {
    if (!me) return;
    derive();
    pingCheck();
    // Keep typing where it was if things are redrawn under you.
    const typingIn = document.activeElement?.dataset?.key;
    main.replaceChildren(view === "people" ? peoplePanel() : view === "ask" ? askPanel() : view === "person" ? personPanel(askDraft.to) : view === "chat" ? chatPanel() : view === "stats" ? statsPanel() : view === "deck" ? deckPanel() : view === "mod" ? modPanel() : view === "messages" ? messagesPanel() : view === "extsettings" ? extSettingsPanel() : cardList());
    main.classList.toggle("main--msgs", view === "messages" || (view === "chat" && EMBED)); // the dark Messages sheet
    if (LIVECHAT && (view !== "cards" || showAll) && main.firstElementChild?.childElementCount !== 0) main.prepend(inlineHead());
    drawDots();
    drawPeek();
    drawStreamerView();
    fitChat();
    shareView();
    settingsBtn.hidden = !PINGS_HERE || !me;
    homeChatBtn.hidden = !LIVECHAT || !me;
    drawDnd();
    if (typingIn) {
      const again = document.querySelector(`[data-key="${typingIn}"]`);
      again?.focus();
      again?.setSelectionRange?.(again.value.length, again.value.length);
    }
    askBtn.classList.toggle("pill--on", DECK ? view === "deck" : view === "ask" || (view === "cards" && !short() && get("askOpen", true)));
    peopleBtn.classList.toggle("pill--badge", requests.length > 0);
    const unreadChat = rooms.reduce((sum, r) => sum + unread(r.owner), 0);
    peopleBtn.title = [requests.length ? `${requests.length} waiting for you to add them back` : "", unreadChat ? `${unreadChat} unread in chat` : ""].filter(Boolean).join(", ");
    peopleBtn.title = peopleBtn.title ? `Connections and chat (${peopleBtn.title})` : "Connections and chat";
    peopleBtn.classList.toggle("pill--on", view === "people" || view === "chat");
    askBtn.textContent = DECK ? "Deck" : view === "ask" ? "Cancel" : "Ask";
    modBtn.hidden = !EMBED || !me;
    const modLive = modRinged();
    const lead = isLeadFor(modOwner());
    // Modding (online and ready to mod): the green sword (hammer for a lead mod). Otherwise
    // your own picture. Either way it wears the bar's only ring.
    const want = modIcon();
    if (modBtn.dataset.icon !== want) {
      modBtn.dataset.icon = want;
      if (want === "pic") {
        const img = el("img", "mod-btn__pic");
        img.src = pics[me.login];
        img.alt = "";
        modBtn.replaceChildren(img);
      } else if (want === "letter") {
        modBtn.replaceChildren(el("span", "mod-btn__letter", me.login[0].toUpperCase()));
      } else modBtn.innerHTML = want === "hammer" ? HAMMER_ICON : SWORD_ICON;
    }
    modBtn.classList.toggle("mod-btn--live", modLive);
    modBtn.classList.toggle("mod-btn--off", !modLive);
    modBtn.dataset.status = myStatus; // its ring takes your status's color (dock.css)
    modBtn.title = modBtn.ariaLabel = `${lead ? "Lead mod" : "Mod"}${modOwner() ? ` · ${modOwner()}` : ""}${modLive ? " · you're an Available mod (ready to mod)" : " · set your status to Available mod to show your sword"}`;
    drawQuickAsk();
    drawPresence();
    statsBtn.hidden = true; // dropped from the bar (Mod and Connections stay); Stats still runs underneath
    statsBtn.classList.toggle("pill--on", view === "stats");
    // Chat lives in Connections now (a Chat button by each person, rooms at the top), so
    // its own button stays hidden; what's unread shows as a count on Connections.
    chatBtn.hidden = true;
    // The side panel's Messages tab carries the unread count; elsewhere it's on Connections.
    msgBtn.hidden = !EMBED || !me;
    msgBtn.classList.toggle("pill--on", view === "messages" || (view === "chat" && chatFrom === "messages"));
    extGear?.classList.toggle("ext-gear--on", view === "extsettings");
    msgCount.textContent = !msgBtn.hidden && unreadChat ? String(unreadChat) : "";
    chatCount.textContent = msgBtn.hidden && unreadChat ? String(unreadChat) : "";
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
    askBtn.hidden = inBar || !me || EMBED; // the side panel has Mod (the sword) instead
    if (!inBar) return;
    const choices = barTargets();
    const want = choices.includes(quickTo.value) ? quickTo.value : defaultTo();
    const labels = choices.map(targetLabel);
    if ([...quickTo.options].map((o) => o.text).join() !== labels.join()) {
      quickTo.replaceChildren(...choices.map((l, k) => new Option(labels[k], l)));
    }
    quickTo.value = want;
    drawQaPick();
    drawQuick();
  }

  // The bar's "send to" picker: each person (picture, online dot), then Mods (your mods
  // on Twitch, the "Your mods" group), then any lists you've made. No Everyone here.
  // It's a drop-down of our own (a plain <select> can't show pictures); the <select>
  // stays underneath, hidden, holding the choice.
  // Mods comes as two: Online mods (only those online right now; nothing waits for the
  // rest: the relay's "online") and All mods (everyone; offline mods see it when back).
  const MODS_TAG = `#${AUTO_GROUPS.mods}`;
  const ONLINE_MODS = "~online-mods";
  // What to send for a choice: Online mods is the mods group, online only.
  const sendTo = (t) => (t === ONLINE_MODS ? { to: MODS_TAG, online: true } : { to: t });
  function barTargets() {
    const able = connections.filter((c) => c.mutual).map((c) => c.login);
    const lists = Object.keys(tags).filter((t) => t !== AUTO_GROUPS.modFor && tags[t].some((l) => able.includes(l)));
    const mods = lists.includes(AUTO_GROUPS.mods) ? [ONLINE_MODS, MODS_TAG] : [];
    const custom = lists.filter((t) => t !== AUTO_GROUPS.mods).sort().map((t) => `#${t}`);
    return [...able, ...mods, ...custom];
  }
  const inList = (tag) => tags[(tag === ONLINE_MODS ? MODS_TAG : tag).slice(1)].filter((l) => conn(l)?.mutual);
  const isGroup = (t) => t.startsWith("#") || t === ONLINE_MODS;
  const modsOnline = () => inList(MODS_TAG).filter((l) => conn(l).online).length;
  const barLabel = (t) => (t === ONLINE_MODS ? "Online mods" : t === MODS_TAG ? "All mods" : t.startsWith("#") ? t.slice(1) : t);
  const MOD_BADGE = '<svg viewBox="-0.5 -0.5 21 21" width="12" height="12" aria-hidden="true"><path fill="#fff" fill-rule="evenodd" d="M19.4 0.6 L13.8 1.6 L5.4 12.8 L7.2 14.6 L18.4 6.2 Z M15.4 4.6 L6.75 12.85 L7.15 13.25 Z"/><g stroke="#fff" stroke-linecap="round" fill="none"><path d="M3.5 12.3 L7.7 16.5" stroke-width="1.8"/><path d="M5.6 14.4 L2.4 17.6" stroke-width="1.5"/></g><circle cx="1.5" cy="18.5" r="1.3" fill="#fff"/></svg>';
  // A VIP's badge, the mod sword's twin: a white gem (flat top, pointed bottom, facets), on
  // VIP pink (#e005b9) wherever it's shown. Ready for VIP mode; nothing uses it yet.
  const VIP_BADGE = '<svg viewBox="-0.5 -0.5 21 21" width="12" height="12" aria-hidden="true"><path fill="#fff" fill-rule="evenodd" d="M5.5 2.5 H14.5 L19.5 8 L10 19 L0.5 8 Z M7.2 8.8 L10 15.4 L12.8 8.8 Z"/><path d="M0.9 8 H19.1" stroke="#e005b9" stroke-width="1.1" fill="none"/></svg>';
  // The little picture: a person's photo, the mod sword for Mods, a tag for a list.
  function barMark(t) {
    if (!isGroup(t)) {
      // A person: their picture, wearing their badge (sword, hammer, or the camera while
      // they're streaming) when they mod for you, as everywhere else.
      let pic;
      if (pics[t]) {
        pic = el("img", "qa__pic");
        pic.src = pics[t];
        pic.alt = "";
      } else pic = el("span", "qa__pic qa__pic--blank", t.slice(0, 1).toUpperCase());
      const rank = rankBadge(t, true);
      if (!rank) return pic;
      const wrap = el("span", "qa__picwrap");
      wrap.append(pic, rank);
      return wrap;
    }
    const mods = t === MODS_TAG || t === ONLINE_MODS;
    const mark = el("span", `qa__pic ${mods ? "qa__pic--mods" : "qa__pic--list"}${t === ONLINE_MODS ? " qa__pic--live" : ""}`);
    mark.innerHTML = mods ? MOD_BADGE : TAG_ICON;
    return mark;
  }
  const qaPick = el("button", "qa__pick");
  qaPick.type = "button";
  qaPick.title = "Who to send to";
  qaPick.setAttribute("aria-haspopup", "listbox");
  quickTo.before(qaPick);
  quickAsk.classList.add("qa--picker");
  // On the page itself (the chat dock's bar clips what hangs below it), under the button.
  const qaMenu = el("div", "qa__menu float-menu");
  qaMenu.setAttribute("role", "listbox");
  qaMenu.hidden = true;
  document.body.append(qaMenu);
  function drawQaPick() {
    const t = quickTo.value;
    qaPick.replaceChildren(barMark(t), el("span", "qa__who", barLabel(t)), el("span", "ask__caret"));
    if (!isGroup(t) && conn(t)?.online) qaPick.querySelector(".qa__pic")?.classList.add("qa__pic--on");
    if (!qaMenu.hidden) drawQaMenu();
  }
  function drawQaMenu() {
    const items = barTargets().map((t) => {
      const item = el("button", `qa__item${t === quickTo.value ? " qa__item--on" : ""}`);
      item.type = "button";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(t === quickTo.value));
      const words = el("span", "qa__words");
      words.append(el("span", "qa__name", barLabel(t)));
      if (t === ONLINE_MODS) {
        const on = modsOnline();
        words.append(el("span", "qa__sub", on ? `${on} online now · only they get it` : "No mods online right now"));
        item.disabled = !on;
      } else if (t === MODS_TAG) {
        const n = inList(t).length;
        words.append(el("span", "qa__sub", `${n} ${n === 1 ? "mod" : "mods"} on Twitch · offline ones see it later`));
      } else if (t.startsWith("#")) {
        const people = inList(t);
        const on = people.filter((l) => conn(l).online).length;
        words.append(el("span", "qa__sub", `${people.length} ${people.length === 1 ? "person" : "people"} · ${on} online`));
      }
      item.append(barMark(t), words);
      if (!isGroup(t) && conn(t)?.online) item.append(el("span", `ask__online${conn(t).idle ? " ask__online--idle" : ""}`));
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        quickTo.value = t;
        rememberTo(t);
        openQaMenu(false);
        drawQaPick();
        drawQuick();
        quickText.focus();
      });
      return item;
    });
    const custom = barTargets().filter((t) => t.startsWith("#") && t !== MODS_TAG);
    const modsAt = items.findIndex((i, k) => barTargets()[k] === ONLINE_MODS);
    if (modsAt > 0) items.splice(modsAt, 0, el("div", "qa__sep"));
    if (!custom.length) items.push(el("div", "qa__hint", "Make your own lists under Connections."));
    qaMenu.replaceChildren(...items);
  }
  function openQaMenu(open) {
    qaMenu.hidden = !open;
    qaPick.setAttribute("aria-expanded", String(open));
    qaPick.classList.toggle("qa__pick--open", open);
    if (!open) return;
    drawQaMenu();
    const at = qaPick.getBoundingClientRect();
    qaMenu.style.top = `${Math.round(at.bottom + 6)}px`;
    qaMenu.style.left = `${Math.round(Math.max(6, at.left))}px`;
  }
  qaPick.addEventListener("click", (e) => {
    e.stopPropagation();
    openQaMenu(qaMenu.hidden);
  });
  qaMenu.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => !qaMenu.hidden && openQaMenu(false));
  document.addEventListener("keydown", (e) => e.key === "Escape" && !qaMenu.hidden && openQaMenu(false));

  // Quick questions beside the bar's Ask field: one tap asks whoever the
  // field's picker is set to. × (on hover) forgets one; + adds one.
  // The questions stay on one line that scrolls sideways (the mouse wheel scrolls it too),
  // so adding one never makes the bar taller.
  quickEl.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || quickEl.scrollWidth <= quickEl.clientWidth) return;
    e.preventDefault();
    quickEl.scrollLeft += e.deltaY;
  }, { passive: false });
  let addingQuick = false;
  // Adding one: the box takes the row's place (the questions come back after), and the row
  // keeps the height it had, so the bar and the chat under it don't jump.
  let quickHeld = 0;
  function startAddingQuick() {
    quickHeld = quickEl.offsetHeight;
    addingQuick = true;
    render();
  }
  function drawQuick() {
    quickEl.classList.toggle("quick--adding", addingQuick);
    quickEl.style.minHeight = addingQuick && quickHeld ? `${quickHeld}px` : "";
    const parts = addingQuick ? [] : presets().map((text) => {
      const sentNow = quickSent === text;
      const b = el("button", `pill pill--quick${sentNow ? " pill--sent" : ""}`);
      b.type = "button";
      b.title = `Send to ${barLabel(quickTo.value || defaultTo())}: ${text}`;
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
      const save = el("button", "quick__save", "Save");
      save.type = "submit";
      const cancel = el("button", "quick__cancel", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("mousedown", (e) => e.preventDefault()); // keep the box's focus
      cancel.addEventListener("click", () => {
        addingQuick = false;
        render();
      });
      form.append(box, save, cancel);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = clean(box.value);
        if (text && !presets().includes(text)) put("presets", [...presets(), text].slice(-MAX_PRESETS));
        addingQuick = false;
        render();
        quickEl.scrollLeft = quickEl.scrollWidth;
      });
      parts.push(form);
      setTimeout(() => box.focus());
    } else if (presets().length < MAX_PRESETS) {
      const add = el("button", "pill pill--icon pill--add", "+");
      add.type = "button";
      add.title = "Add a quick question";
      add.addEventListener("click", startAddingQuick);
      parts.push(add);
    }
    quickEl.replaceChildren(...parts);
  }

  // Side panel only: how your connections see you. The button opens a little menu of the
  // three to pick from.
  const STATUS = {
    modding: { label: "Available mod", says: "Online and ready to mod (the default): your Mod button shows the sword." },
    online: { label: "Online", says: "Online, but not modding right now." },
    idle: { label: "Idle", says: "Shown as away for a bit." },
    offline: { label: "Invisible", says: "Others see you as offline. Things still reach you here." },
  };
  const presenceMenu = el("div", "presence__menu");
  presenceMenu.setAttribute("role", "menu");
  presenceMenu.hidden = true;
  presenceBtn.after(presenceMenu);
  function drawPresence() {
    presenceBtn.hidden = !EMBED;
    if (!EMBED) return;
    const now = STATUS[myStatus] || STATUS.modding;
    presenceBtn.className = `presence presence--bar presence--${myStatus}${presenceMenu.hidden ? "" : " presence--open"}`;
    // Just the dot (saves room in the bar); the words are in its tooltip and menu.
    if (!presenceBtn.querySelector(".presence__spin, .presence__now")) presenceBtn.textContent = "";
    presenceBtn.ariaLabel = now.label;
    presenceBtn.title = `${now.label}${myStatus !== "offline" && mySince ? ` since ${clock(mySince)}` : ""}. ${now.says} Click to change.`;
    presenceBtn.setAttribute("aria-haspopup", "menu");
    presenceBtn.setAttribute("aria-expanded", String(!presenceMenu.hidden));
  }
  // Opening the panel: "online" written in a tilted ring round your dot, like a planet's, orbits for a few seconds and fades.
  // It plays when the panel opens, then once every 10 minutes while it stays open.
  const SPIN_AGAIN_MS = 10 * 60 * 1000;
  function spinPresence() {
    if (!EMBED || presenceBtn.hidden || myStatus === "offline") return;
    if (presenceBtn.querySelector(".presence__spin")) return;
    const word = myStatus === "idle" ? "idle" : "online"; // Modding is online too
    const ring = el("span", "presence__spin");
    ring.setAttribute("aria-hidden", "true");
    ring.innerHTML = `<svg viewBox="0 0 40 40"><defs><path id="presenceArc" d="M20 20 m-13 0 a13 13 0 1 1 26 0 a13 13 0 1 1 -26 0"/></defs><text><textPath href="#presenceArc" textLength="80" lengthAdjust="spacing">${word} · ${word} ·</textPath></text></svg>`;
    presenceBtn.append(ring);
    setTimeout(() => ring.remove(), 2700);
  }
  setInterval(spinPresence, SPIN_AGAIN_MS);
  // The first time you open the panel in 24 hours: what you are, in bold white pixel-edged
  // words beside your little person ("Available mod", or "Online Now!"), instead of the
  // spin, for 4 seconds, then it fades.
  function onlineNow() {
    if (!EMBED || presenceBtn.hidden || !["modding", "online"].includes(myStatus) || Date.now() - get("onlineNowAt", 0) < 24 * 3600 * 1000) return false;
    put("onlineNowAt", Date.now());
    const tag = el("span", "presence__now", myStatus === "modding" ? "Available mod" : "Online Now!");
    tag.setAttribute("aria-hidden", "true");
    presenceBtn.append(tag);
    setTimeout(() => tag.remove(), 4700);
    return true;
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

  // When you last talked with someone: a question or note either way, an answer either
  // way, or a private message either way. 0 if never (that we know of).
  const TALKED_MS = 5 * 60 * 1000;
  function lastTalked(login) {
    let at = 0;
    for (const q of Object.values(inbox)) if (q.from === login) at = Math.max(at, q.at || 0, q.answered?.at || 0, q.seenAt || 0);
    for (const q of Object.values(sent)) if (q.to === login) at = Math.max(at, q.at || 0, q.answer?.at || 0);
    const direct = directWith(login);
    for (const m of (direct && chat[direct.owner]) || []) at = Math.max(at, m.at || 0);
    return at;
  }
  const talkedLately = (login) => Date.now() - lastTalked(login) < TALKED_MS;
  // One of your mods (from Twitch): their dot wears a small sword.
  const isMyMod = (login) => !!modLists?.mods?.includes(login);
  // One of your lead mods: your chat dock remembers them ("leads"); elsewhere it's in the
  // Streamer View your dock shares.
  const isMyLead = (login) => isMyMod(login) && (get("leads", []).includes(login) || !!(me && views[me.login]?.leads?.includes(login)));
  // Your mod's badge, wherever they show (pictures, names, private chat): the hammer for a
  // lead mod, else the sword, on mod green. corner: tucked on a picture's bottom-right;
  // otherwise it sits next to their name. null for anyone who doesn't mod for you.
  // Live streaming right now (asks Twitch when it's been a while). Someone streaming
  // can't mod for you, so they lose the sword or hammer and the green ring and wear the
  // purple camera instead.
  function streaming(login) {
    // Testing on this Mac (and the public demo): their chat dock being open stands in for live.
    if (TESTING) return views[login]?.chat === "livechat";
    const known = liveOf[login];
    if (!known || Date.now() - known.at > LIVE_CHECK_MS) checkLive(login);
    return !!known?.live;
  }
  const CAM_BADGE = '<svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true"><rect x="1.5" y="5" width="12" height="10" rx="2.2" fill="#fff"/><path d="M14.5 8.6 L18.5 6.3 V13.7 L14.5 11.4 Z" fill="#fff"/></svg>';
  function liveBadge(corner = false) {
    const b = el("span", `rank rank--live${corner ? " rank--corner" : ""}`);
    b.innerHTML = CAM_BADGE;
    b.title = "Live streaming now";
    return b;
  }
  function rankBadge(login, corner = false) {
    if (!login || !isMyMod(login)) return null;
    if (streaming(login)) return liveBadge(corner);
    const lead = isMyLead(login);
    const b = el("span", `rank rank--${lead ? "lead" : "mod"}${corner ? " rank--corner" : ""}`);
    b.innerHTML = lead ? HAMMER_ICON : MOD_BADGE;
    b.title = lead ? "Your lead mod" : "Your mod";
    return b;
  }
  const withBadge = (node, login) => {
    const b = rankBadge(login);
    if (b) node.append(b);
    return node;
  };

  // The dots: one per connection; glowing green ring while you've talked in the last
  // 5 minutes (not just because they're online), faded until they've added you back;
  // pulsing in their chat color for a question from them, ringed for their answer to
  // yours, with how many. Your mods wear a sword. The streamer's chat dock shows only
  // its mods who are connections and are in the chat.
  function drawDots() {
    const modBar = EMBED && view === "mod" && !!me;
    dotsEl.classList.toggle("dots--mod", modBar);
    if (modBar) return drawModDots();
    // Your own chat color, for the glow round lines you bookmarked.
    if (me && colorOf(me.login)) document.body.style.setProperty("--my-color", colorOf(me.login));
    const dots = connections.map(({ login, mutual, online, idle }) => {
      const fromThem = Object.values(inbox).filter((q) => q.from === login && !q.done);
      const asks = fromThem.length;
      const answers = Object.values(sent).filter((q) => q.to === login && q.answer && !q.answer.seen).length;
      const direct = directWith(login);
      const said = direct ? unread(direct.owner) : 0; // private messages only count; they don't pulse
      // The chat dock: only people who are or have been in the chat this stream (or
      // have something waiting). Bright while they're there, faded once they leave.
      const light = LIVECHAT && mutual ? liveLight(login) : null;
      // Never been in the chat this stream: no picture. Been and gone: gray. Gone for 30
      // minutes: no picture again (unless something from them is waiting).
      if (light && !light.away) liveSeenNow(login);
      const longGone = light?.away && Date.now() - liveSeenAt(login) > LIVE_GONE_MINUTES * LIGHT_MINUTE;
      // The chat dock lists all your mods (like a mod's Streamers bar lists theirs): the
      // chat's rings while they're in the chat this stream, otherwise a green glow while
      // they're online, grayed with a badge while they're not.
      if (LIVECHAT && !isMyMod(login)) return null;
      const inChat = !!(light && liveWasHere(login) && !longGone);
      const shown = LIVECHAT && !inChat ? null : light;
      const onAir = isMyMod(login) && streaming(login); // can't mod for you right now
      const lit = mutual && !onAir && (LIVECHAT ? !inChat && online && !idle : talkedLately(login));
      const dot = el("button", `dot${asks ? " dot--ask" : answers ? " dot--answer" : ""}${mutual ? "" : " dot--waiting"}${lit ? " dot--online" : ""}${idle ? " dot--idle" : ""}${shown?.ring && !onAir ? ` dot--${shown.ring}` : ""}${shown?.away ? " dot--away" : shown && (!shown.ring || onAir) ? " dot--here" : ""}`);
      // Order for the chat dock: lead mods first, then whoever's online, then by name.
      dot.dataset.order = `${isMyLead(login) ? 0 : 1}${online && !idle ? 0 : 1}${login}`;
      dot.type = "button";
      // The streamer's dock: a mod set to Idle, or not on Streamer Buddy right now (or set to
      // Offline), is grayed out with a white badge, so it's clear to leave them be.
      const resting = LIVECHAT && mutual && (idle || !online) ? (idle ? "idle" : "offline") : "";
      if (resting) dot.classList.add("dot--resting", `dot--resting-${resting}`);
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
        : resting === "idle" ? `${login} is idle: they'd like to be left alone for now${shown ? ` (${shown.says})` : ""}`
        : resting ? `${login} is offline in Streamer Buddy${whenWords(conn(login)) ? ` (${whenWords(conn(login))})` : ""}: anything you send waits for them${shown ? ` (${shown.says})` : ""}`
        : shown ? `${login}: ${shown.says}${idle ? ", set to idle" : ""}`
        : `${login}${idle ? " (idle)" : online ? " (online)" : ""}${whenWords(conn(login)) ? ` · ${whenWords(conn(login))}` : ""}`;
      if (pics[login]) {
        const img = el("img");
        img.src = pics[login];
        img.alt = "";
        dot.append(img);
      } else {
        dot.append(el("span", "dot__letter", login[0].toUpperCase()));
      }
      if (resting) {
        const badge = el("span", "dot__rest");
        // Idle: a moon. Offline: a small power symbol.
        badge.innerHTML = resting === "idle"
          ? svg(`<path d="M15.5 12.2A6 6 0 1 1 7.8 4.5a4.7 4.7 0 0 0 7.7 7.7z" ${LINE} stroke-width="2.4"/>`, 9)
          : svg(`<path d="M10 3.5v6" ${LINE} stroke-width="2.6"/><path d="M6.2 6.2a5.6 5.6 0 1 0 7.6 0" ${LINE} stroke-width="2.6"/>`, 9);
        dot.append(badge);
      }
      const rank = rankBadge(login, true);
      if (rank) dot.append(rank);
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
    // The chat dock: your mods who aren't on Streamer Buddy yet, too, dimmed with the
    // broken chain (as on a mod's Streamers bar).
    if (LIVECHAT && me) {
      const known = new Set(connections.map((c) => c.login));
      for (const login of (modLists?.mods || []).filter((l) => !known.has(l) && l !== me.login)) {
        const dot = el("button", "dot dot--chan dot--off dot--absent");
        dot.type = "button";
        if (pics[login]) {
          const img = el("img");
          img.src = pics[login];
          img.alt = "";
          dot.append(img);
        } else dot.append(el("span", "dot__letter", login[0].toUpperCase()));
        const rank = rankBadge(login, true);
        if (rank) dot.append(rank);
        const x = el("span", "dot__unlinked");
        x.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.2 5.6 L9.6 4.2 a3.3 3.3 0 0 1 4.7 4.7 L12.9 10.3"/><path d="M11.8 14.4 L10.4 15.8 a3.3 3.3 0 0 1 -4.7 -4.7 L7.1 9.7"/><path d="M3.2 3.2 L5 5 M15 15 L16.8 16.8 M2.6 7.4 H4.4 M15.6 12.6 H17.4"/></g></svg>';
        dot.append(x);
        dot.title = `${login} · your mod · not on Streamer Buddy yet`;
        dot.dataset.order = `2${login}`;
        dots.push(dot);
      }
    }
    const list = dots.filter(Boolean);
    if (LIVECHAT) list.sort((a, b) => a.dataset.order.localeCompare(b.dataset.order));
    // The streamer's twin of the mod side's camera: a faded green sword at the bar's left
    // edge, so it's clear these are your mods.
    dotsEl.classList.toggle("dots--mods", LIVECHAT && list.length > 0);
    if (LIVECHAT && list.length) {
      const label = el("span", "dots__label dots__label--sword");
      label.innerHTML = SWORD_ICON.replaceAll("#fff", "currentColor");
      label.title = "Your mods in the chat.";
      list.unshift(label);
    }
    dotsEl.replaceChildren(...list);
  }

  // The side panel's Mod view: the top bar is the channels you mod instead, the ones you're
  // lead mod for first (hammer), then the rest (sword). Online ones glow lavender; offline
  // ones still show, dimmed; the one Mod is about is ringed in mod green. Clicking one switches Mod to them.
  function modChannels() {
    const modFor = modLists?.modFor || [];
    const sharing = Object.keys(views).filter((l) => l !== me.login && isLeadFor(l));
    const all = [...new Set([...modFor, ...sharing])];
    const up = (l) => (streaming(l) ? 2 : conn(l)?.online ? 1 : 0);
    return all.sort((a, b) => isLeadFor(b) - isLeadFor(a) || up(b) - up(a) || a.localeCompare(b));
  }
  function drawModDots() {
    const owner = modOwner();
    const dots = modChannels().map((login) => {
      const lead = isLeadFor(login);
      const live = streaming(login);
      const on = !!conn(login)?.online; // on StreamerSpace: shown plain, not dimmed
      // Lit (the lavender glow) only while they're actually streaming.
      // Not on Streamer Buddy yet (not a connection either way): their Twitch picture with
      // a small broken-chain badge (not linked with you yet).
      const absent = !conn(login) && !requests.includes(login);
      const dot = el("button", `dot dot--chan${login === owner ? " dot--current" : ""}${live ? " dot--on dot--live" : on ? "" : " dot--off"}${absent ? " dot--absent" : ""}`);
      dot.type = "button";
      if (colorOf(login)) dot.style.setProperty("--c", colorOf(login));
      if (pics[login]) {
        const img = el("img");
        img.src = pics[login];
        img.alt = "";
        dot.append(img);
      } else dot.append(el("span", "dot__letter", login[0].toUpperCase()));
      // Every streamer here wears the purple camera. One who also mods for you wears their
      // sword (hammer for your lead mod) beside it: two badges in the corner. Not while
      // they're live, though: streaming, they can't mod for you.
      const pair = el("span", "rank-pair");
      const cam = liveBadge();
      cam.title = live ? "Live streaming now" : "Streamer";
      pair.append(cam);
      if (isMyMod(login) && !live) {
        const theirLead = isMyLead(login);
        const r = el("span", `rank rank--${theirLead ? "lead" : "mod"}`);
        r.innerHTML = theirLead ? HAMMER_ICON : MOD_BADGE;
        r.title = theirLead ? "Also your lead mod" : "Also your mod";
        pair.prepend(r);
      }
      dot.append(pair);
      if (absent) {
        // A small broken chain: not linked with you yet.
        const x = el("span", "dot__unlinked");
        x.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.2 5.6 L9.6 4.2 a3.3 3.3 0 0 1 4.7 4.7 L12.9 10.3"/><path d="M11.8 14.4 L10.4 15.8 a3.3 3.3 0 0 1 -4.7 -4.7 L7.1 9.7"/><path d="M3.2 3.2 L5 5 M15 15 L16.8 16.8 M2.6 7.4 H4.4 M15.6 12.6 H17.4"/></g></svg>';
        dot.append(x);
      }
      dot.title = `${login} · you're ${lead ? "lead mod" : "a mod"} here${isMyMod(login) ? ` · ${isMyLead(login) ? "your lead mod" : "your mod"} too` : ""} · ${absent ? "not on Streamer Buddy yet" : live ? "live now" : on ? "online" : "offline"}${login === owner ? " (showing)" : ""}`;
      dot.addEventListener("click", () => {
        svPicked = login;
        watching = ""; // picked by hand: stop following the tab until it changes channel
        render();
      });
      return dot;
    });
    // A small label, so it's clear these are your streamers and not your connections.
    // A faded camera at the bar's left edge: these are your streamers.
    const label = el("span", "dots__label");
    label.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="1.5" y="5" width="12" height="10" rx="2.2" fill="currentColor"/><path d="M14.5 8.6 L18.5 6.3 V13.7 L14.5 11.4 Z" fill="currentColor"/></svg>';
    label.title = "The channels you mod. Click one to see it.";
    dotsEl.replaceChildren(label, ...dots);
  }

  function cardList() {
    const wrap = el("div", "cards");
    if (signinNote()) wrap.append(signinPill());
    // The chat dock: the newest is in the bar; all of them only when asked for ("+2" or a
    // picture), just under the bar.
    if (LIVECHAT && !showAll) return wrap;
    if (!POPOUT && !DECK && !LIVECHAT) wrap.append(composer(null)); // the chat dock sends from its bar
    // Newest first in each list, so something new is at the top where it's seen; what's
    // waiting on you puts warnings and nudged ones above the rest.
    const answers = Object.keys(sent).filter((id) => sent[id].answer && !sent[id].answer.seen).sort((a, b) => sent[b].answer.at - sent[a].answer.at);
    const waiting = Object.keys(sent).filter((id) => !sent[id].answer && !sent[id].seen).sort((a, b) => sent[b].at - sent[a].at);
    const open = Object.keys(inbox).filter((id) => !inbox[id].done).sort((a, b) => stageFor(inbox[b]) - stageFor(inbox[a]) || inbox[b].at - inbox[a].at);
    const replied = Object.keys(inbox).filter((id) => inbox[id].answered && !inbox[id].cleared).sort((a, b) => inbox[b].answered.at - inbox[a].answered.at);
    // "Clear all", as plain text between the Ask box and the lists (the side panel): puts
    // away everything below in one go. Connection requests stay.
    if (EMBED && open.length + answers.length + replied.length + waiting.length) {
      const all = el("button", "cards__clearall", "Clear all");
      all.type = "button";
      all.title = "Clear everything below: questions to you dismissed, messages marked seen, answers put away, and your waiting questions hidden here";
      all.addEventListener("click", () => clearAll({ open, answers, replied, waiting }));
      wrap.append(all);
    }
    for (const login of requests) wrap.append(requestRow(login));
    if (open.length) wrap.append(inboxList(open)); // waiting on you: first
    if (answers.length) wrap.append(answerList(answers));
    if (replied.length) wrap.append(repliedList(replied));
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

  // Clear all: what each line's own X does, for every line at once.
  function clearAll({ open, answers, replied, waiting }) {
    for (const id of open) {
      if (inbox[id].note) relay({ t: "seen", id }); // a message: they see you've seen it
      else relay({ t: "dismiss", id }); // a question: dismissed without answering
      pending[id] = true;
      delete drafts[id];
    }
    for (const id of answers) {
      if (sent[id].answer.acked !== true && !pending[id]) relay({ t: "seen", id });
      ui[id] = { ...ui[id], closed: true };
    }
    for (const id of replied) ui[id] = { ...ui[id], cleared: true };
    for (const id of waiting) {
      const group = sent[id].group;
      for (const [cid, c] of Object.entries(sent)) if (cid === id || (group && c.group === group)) ui[cid] = { ...ui[cid], waitClosed: true };
    }
    replyOpen.clear();
    put("ui", ui);
    render();
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

  // Questions and messages to you: a slim list like the answers to yours. One line each:
  // who, what they said, and small buttons on the right: their answers for a question
  // (heart, check, X for the streamer), or Seen for a message; a reply button that opens
  // a reply box under the line only when wanted; and × to dismiss. Hovering a line turns
  // it into a glowing pill. (The phone deck keeps the big cards, for thumbs.)
  const replyOpen = new Set(); // question ids with their reply box open
  function inboxList(ids) {
    const list = el("div", "ilist");
    list.setAttribute("role", "list");
    for (const id of ids) list.append(inboxRow(id));
    return list;
  }
  function inboxRow(id) {
    const q = inbox[id];
    const wrap = el("div", "irow__wrap");
    wrap.setAttribute("role", "listitem");
    const row = el("div", `irow irow--${stageFor(q)}${replyOpen.has(id) ? " irow--open" : ""}`);
    const dot = el("span", `peek__ping peek__ping--${stageFor(q)}`);
    dot.title = q.warns ? "Sent as a warning: needs you now" : q.nudges ? `Nudged ${q.nudges} time${q.nudges === 1 ? "" : "s"}` : "";
    const who = el("b", "irow__who", q.name);
    if (colorOf(q.from)) who.style.color = colorOf(q.from);
    const text = el("span", "irow__text");
    text.append(who, el("span", "irow__msg", q.text));
    if (q.group) text.append(el("span", "irow__to", ` to ${askedWho(q)}`));
    const acts = el("div", "irow__acts");
    const act = (cls, html, label, onClick) => {
      const b = el("button", `irow__btn ${cls}`);
      b.type = "button";
      b.title = label;
      b.setAttribute("aria-label", label);
      b.disabled = q.sending;
      if (html) b.innerHTML = html;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });
      return b;
    };
    if (q.note) {
      const seen = act("irow__btn--seen", svg(ANSWERS.y.icon, 14), `Let ${q.name} know you've seen this`, () => ack(id));
      seen.append(el("span", null, q.sending ? "Sending…" : "Seen"));
      acts.append(seen);
    } else {
      for (const { code, label } of answerChoices(q)) {
        const b = act(`answer--${code}${code === "x" ? " irow__btn--own" : ""}`, code === "x" ? "" : svg(ANSWERS[code].icon, 14), label, () => answer(id, code, code === "x" ? label : ""));
        if (code === "x") b.textContent = label;
        acts.append(b);
      }
    }
    acts.append(
      act(`irow__btn--reply${replyOpen.has(id) ? " irow__btn--on" : ""}`, svg(ANSWERS.c.icon, 14), "Type a reply", () => {
        replyOpen.has(id) ? replyOpen.delete(id) : replyOpen.add(id);
        render();
        if (replyOpen.has(id)) document.querySelector(`[data-key="reply-${id}"]`)?.focus();
      }),
      act("irow__btn--x", "", q.note ? "Dismiss" : "Dismiss without answering", () => dismiss(id)),
    );
    acts.lastChild.textContent = "×";
    row.append(dot, text, acts);
    // Clicking the line itself (not one of its buttons): a message is marked seen, like the
    // answers list; a question opens its reply box.
    row.title = q.note ? `Click to let ${q.name} know you've seen this` : "Click to type a reply, or use the buttons";
    row.addEventListener("click", (e) => {
      if (e.target.closest("button, input, a") || q.sending) return;
      if (q.note) return ack(id);
      replyOpen.add(id);
      render();
      document.querySelector(`[data-key="reply-${id}"]`)?.focus();
    });
    wrap.append(row);
    if (replyOpen.has(id)) {
      const own = el("form", "irow__reply");
      const input = textBox(`Reply to ${q.name}…`, drafts[id] || "");
      input.dataset.key = `reply-${id}`;
      input.maxLength = MAX_LEN;
      input.addEventListener("input", () => (drafts[id] = input.value));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          replyOpen.delete(id);
          render();
        }
      });
      const send = el("button", "irow__send");
      send.type = "submit";
      send.title = "Send reply";
      send.setAttribute("aria-label", "Send reply");
      send.disabled = q.sending;
      send.innerHTML = `<svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 16V4M5 9l5-5 5 5"/></svg>`;
      own.append(input, send);
      own.addEventListener("submit", (e) => {
        e.preventDefault();
        const reply = clean(input.value);
        if (!reply) return;
        replyOpen.delete(id);
        answer(id, "c", reply);
      });
      wrap.append(own);
    }
    return wrap;
  }

  // Your answers to their questions, until you clear them: the same slim line, with ✓ Seen
  // once they've marked it seen. Hover for the pill; click clears it.
  function repliedList(ids) {
    const list = el("div", "alist");
    for (const id of ids) {
      const q = inbox[id];
      const a = ANSWERS[q.answered.code] || ANSWERS.c;
      const row = el("button", "arow arow--mine");
      row.type = "button";
      row.title = `You answered ${q.name} "${said(q.answered)}" to: ${q.text}. Click to clear.`;
      const icon = el("span", `arow__icon answer--${q.answered.code}`);
      icon.innerHTML = svg(a.icon, 15);
      const text = el("span", "arow__text");
      const who = el("b", "arow__who", `You → ${q.name}`);
      text.append(who, el("span", "arow__said", said(q.answered)), el("span", "arow__q", q.text));
      row.append(icon, text, el("span", "arow__ago", q.seenAt ? "✓ Seen" : "Sent"), el("span", "arow__act", "Clear"));
      row.addEventListener("click", () => setUi(id, { cleared: true }));
      list.append(row);
    }
    return list;
  }

  // The phone deck's big card for a question to you.
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

  // Answers to questions you asked: a slim list, one line each (who, their answer, your
  // question, how long ago), as wide as there's room for. Hovering a line turns it into a
  // glowing pill button; clicking it marks the answer seen (they hear) and clears it.
  function answerList(ids) {
    const list = el("div", "alist");
    list.setAttribute("role", "list");
    for (const id of ids) list.append(answerRow(id));
    return list;
  }
  function answerRow(id) {
    const q = sent[id];
    const a = ANSWERS[q.answer.code] || ANSWERS.c;
    const row = el("button", "arow");
    row.type = "button";
    row.setAttribute("role", "listitem");
    row.title = `${q.to} answered "${said(q.answer)}" to: ${q.text}. Click to mark it seen.`;
    const icon = el("span", `arow__icon answer--${q.answer.code}`);
    icon.innerHTML = svg(a.icon, 15);
    const who = el("b", "arow__who", q.to);
    if (colorOf(q.to)) who.style.color = colorOf(q.to);
    const text = el("span", "arow__text");
    text.append(who, el("span", "arow__said", said(q.answer)), el("span", "arow__q", q.group ? `${q.text} (asked ${askedWho(q)})` : q.text));
    row.append(icon, text, el("span", "arow__ago", ago(q.answer.at)), el("span", "arow__act", q.answer.acked === "sending" ? "Sending…" : "Got it"));
    row.disabled = q.answer.acked === "sending";
    row.addEventListener("click", () => {
      if (q.answer.acked !== true) ack(id);
      setUi(id, { closed: true });
    });
    return row;
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


  // The bar's message area: what's waiting for you (questions and messages to you, and
  // answers to your questions you haven't marked seen), one at a time, with its answers;
  // or else a connection request. In the streamer's chat dock it's the place to look:
  // boxed, a little larger, in the color of what it shows.
  //
  // More than one: they take turns, a new one every PEEK_TURN_MS, with dots for how many
  // and which (click one to show it). Something new jumps straight in. It holds still
  // while the pointer is over it or you're typing a reply. "See all" opens the full list.
  const PEEK_TURN_MS = 6000;
  let peekMenu = false; // the short list of everything waiting, dropped down from "2 of 5 ▾"
  let peekMenuAt = 0;
  const PEEK_MENU_IDLE_MS = 8000; // left open and not pointed at: it closes, the turns carry on
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
  const peekHeld = () => peekMenu || peekHover || peekEl.matches(":hover") || peekEl.contains(document.activeElement) || !!drafts[peekId];
  // Clicking anywhere else closes the short list (and the turns carry on).
  document.addEventListener("click", (e) => {
    if (peekMenu && !peekEl.contains(e.target)) {
      peekMenu = false;
      drawPeek();
    }
  });

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
    if (peekMenu && !peekHover && Date.now() - peekMenuAt > PEEK_MENU_IDLE_MS) {
      peekMenu = false;
      peekSince = Date.now();
      drawPeek();
    }
    if (peekMenu && peekHover) peekMenuAt = Date.now();
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
    // Which one this is, of how many ("2 of 5"): just a label. The arrows either side step
    // through them, and the turns carry on by themselves.
    peekMenu = false;
    if (items.length > 1) {
      const at = items.findIndex((it) => it.id === peekId);
      const pager = el("div", "peek__pager");
      pager.append(el("span", "peek__count", `${at + 1} of ${items.length}`));
      parts.push(pager);
    }
    // The X that clears this one (dismissed, unanswered, or an answer put away): in the
    // chat dock it sits big in the card's top corner, so it's one tap to be rid of it.
    parts.find((p) => p.classList?.contains("x"))?.classList.add("peek__dismiss");
    // More than one: arrows either side to step through them (round and round).
    if (items.length > 1) {
      const at = items.findIndex((it) => it.id === peekId);
      const step = (by, label, glyph) => {
        const b = el("button", `peek__arrow peek__arrow--${by < 0 ? "prev" : "next"}`, glyph);
        b.type = "button";
        b.title = label;
        b.setAttribute("aria-label", label);
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          peekId = items[(at + by + items.length) % items.length].id;
          peekSince = Date.now();
          peekMenu = false;
          drawPeek();
        });
        return b;
      };
      parts.unshift(step(-1, "Previous one", "‹"));
      parts.push(step(1, "Next one", "›"));
      peekEl.classList.add("peek--paged");
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
  // it moves up a color each time: orange, yellow, then white (see "Pings"). For a
  // question to several people, it nudges everyone who hasn't answered.
  //
  // While it can't be nudged (just nudged, or already white), the button still takes
  // taps: WARN_TAPS of them in quick succession sends them a warning, a heads-up that
  // something needs them right now (a mod looking out for the streamer), red on their
  // screen with a louder beep. At most one every WARN_GAP_MS (the relay's limits too).
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
    const next = Math.min(PING_TOP, nudges + 2); // the color a nudge turns it
    const done = nudges >= PING_TOP - 1;
    const wait = Math.max(0, ...qs.map((q) => q.nudgedAt + NUDGE_GAP_MS - Date.now()));
    const warnWait = Math.max(0, ...qs.map((q) => q.warnedAt + WARN_GAP_MS - Date.now()));
    const canNudge = !done && wait <= 0;
    const taps = (warnTaps.get(key) || []).filter((t) => Date.now() - t < WARN_WINDOW_MS);
    const busy = ids.some((id) => nudging.has(id));
    const color = warns ? PING_WARN : canNudge ? next : done ? PING_TOP : nudges + 1;
    const b = el("button", `nudge nudge--${color}${warns ? " nudge--warned" : ""}${taps.length ? " nudge--arming" : ""}`);
    b.type = "button";
    const label = taps.length ? `Send warning: ${WARN_TAPS - taps.length} more` : warns ? "Warning sent" : canNudge ? (nudges ? "Nudge again" : "Nudge") : done ? "Nudged 3×" : "Nudged";
    b.append(el("span", `peek__ping peek__ping--${color}`), el("span", null, label));
    b.disabled = busy || (!canNudge && warnWait > 0);
    b.title = canNudge
      ? `Remind them: it turns ${PING_NAMES[next].toLowerCase()} on their screen, with a soft beep`
      : warnWait > 0 ? "Your warning just went to them; give them a moment"
      : `Something needs them right now? Tap ${WARN_TAPS} times quickly to send them a warning (red on their screen, louder beep)`;
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
  let modeMenuOpen = false; // the Send box's Ask / Quick info / !vanish pull-down
  document.addEventListener("click", () => {
    if (!modeMenuOpen) return;
    modeMenuOpen = false;
    render();
  });

  // Quick questions: saved on this device; in a one-row bar they're one tap
  // to everyone.
  const MAX_PRESETS = 8;
  const presets = () => get("presets", ["Can you post the Discord link?", "Anyone free to help?"]);
  if (DECK && localStorage.getItem("askOpen") === null) put("askOpen", false);
  let quickSent = ""; // the quick question just sent, shown as "Sent" for a moment

  function sendQuick(text) {
    const to = quickTo.value || defaultTo();
    if (relay({ t: "ask", ...sendTo(to), text, ...askOrSay(text) })) {
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
    chip.append(withBadge(el("span", "ask__name", login), login));
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
  // bare: no "Send to" line (Mod, where it's always the streamer of the stream you're on).
  function composer(fixedTo, alwaysOpen = false, bare = false) {
    const box = el("section", "ask send");
    const able = connections.filter((c) => c.mutual).map((c) => c.login);
    const open = alwaysOpen || get("askOpen", true);
    const fold = () => {
      put("askOpen", !open);
      render();
    };
    if (!open) {
      const head = el("button", "ask__head send__fold");
      head.type = "button";
      head.append(el("span", "ask__title", fixedTo ? `To ${fixedTo}` : "Send"), el("span", "ask__chev"));
      head.addEventListener("click", fold);
      box.append(head);
      return box;
    }
    if (!fixedTo && !able.length) {
      box.append(el("div", "ask__title", "Send"), el("p", "ask__hint", "Add someone under Connections first. You can ask each other once you've both added each other."));
      return box;
    }

    // The top line: "Send to" and who (a chip that drops down the rest), and the fold.
    const top = el("div", "send__top");
    top.append(el("span", "send__label", "Send to"));
    if (fixedTo) top.append(personChip(fixedTo, "ask__person ask__person--on send__who"));
    else {
      if (!targets().includes(askDraft.to)) askDraft.to = defaultTo();
      const who = el("div", "ask__who send__whowrap");
      const pick = personChip(askDraft.to, "ask__person ask__person--on send__who");
      pick.append(el("span", `ask__caret${pickerOpen ? " ask__caret--open" : ""}`));
      pick.title = "Send to someone else";
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
      top.append(who);
    }
    if (!alwaysOpen) {
      const chev = el("button", "send__chev");
      chev.type = "button";
      chev.title = "Fold away";
      chev.setAttribute("aria-label", "Fold away");
      chev.append(el("span", "ask__chev ask__chev--open"));
      chev.addEventListener("click", fold);
      top.append(chev);
    }
    if (!bare) box.append(top);
    else box.classList.add("send--bare");
    const to = () => fixedTo || askDraft.to;

    // What you're sending, as tabs: a question, a quick note, or a !vanish note.
    // A streamer only asks.
    const mode = STREAMER ? "ask" : askDraft.mode;
    const input = textBox(mode === "love" ? "Say something quick (it won't stick around)" : mode === "info" ? "What do they need to know?" : "What do you want to ask?", askDraft.text);
    input.dataset.key = fixedTo ? `ask-${fixedTo}` : "ask";
    input.className = "ask__input send__input";
    input.maxLength = mode === "love" ? 80 : MAX_LEN;
    input.addEventListener("input", () => (askDraft.text = input.value));

    const form = el("form", `send__bar send__bar--${mode}`);
    const send = el("button", "send__go");
    send.type = "submit";
    send.title = "Send";
    send.setAttribute("aria-label", "Send");
    send.innerHTML = `<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 16V4M5 9l5-5 5 5"/></svg>`;
    // Inside the bar, at its left: what you're sending, as a small pull-down.
    if (!STREAMER) {
      const MODES = [["ask", "Ask"], ["info", "Quick info"], ["love", "!vanish"]];
      const wrap = el("div", "send__modewrap");
      const pickMode = el("button", "send__modepick");
      pickMode.type = "button";
      pickMode.title = "What you're sending";
      pickMode.setAttribute("aria-haspopup", "listbox");
      pickMode.setAttribute("aria-expanded", String(modeMenuOpen));
      pickMode.append(el("span", null, MODES.find(([v]) => v === mode)[1]), el("span", "send__modecaret"));
      pickMode.addEventListener("click", (e) => {
        e.stopPropagation();
        modeMenuOpen = !modeMenuOpen;
        render();
      });
      wrap.append(pickMode);
      if (modeMenuOpen) {
        const menu = el("div", "send__modemenu");
        menu.setAttribute("role", "listbox");
        for (const [value, label] of MODES) {
          const item = el("button", `send__modeitem${value === mode ? " send__modeitem--on" : ""}`, label);
          item.type = "button";
          item.setAttribute("role", "option");
          item.setAttribute("aria-selected", String(value === mode));
          item.addEventListener("click", (e) => {
            e.stopPropagation();
            modeMenuOpen = false;
            askDraft.mode = value;
            askDraft.note = "";
            render();
            document.querySelector(`[data-key="${input.dataset.key}"]`)?.focus();
          });
          menu.append(item);
        }
        wrap.append(menu);
      }
      form.append(wrap);
    }
    form.append(input, send);
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
      : "They answer with ♥, ✓, ✗ or ? (maybe), or type a reply."));
    if (askDraft.note) box.append(el("p", "ask__note", askDraft.note));
    return box;
  }

  // One person's page: ask them something, and the log of everything between
  // you, newest first. Waiting questions to you show as full cards on top.
  // Mod (the sword, the side panel's first button): everything about the stream you're on.
  // Who it's for follows the Twitch tab (modOwner); the picker switches by hand. Then:
  //   - their feed: what their OBS dock shows right now (Streamer View, drawn in here)
  //   - their reactions: how they answered what you sent, newest first
  //   - your thread with them: the Send box and the history, same as their own page
  //   - anything waiting from someone else, underneath, so nothing hides
  const MAX_REACTIONS = 8;

  // The sword's ring: only while you're on the stream of someone live right now, and you
  // show as online (so they see you're there). Live comes from Twitch, checked every 2
  // minutes for the stream you're on; testing on this Mac (and the public demo), their
  // chat dock being open stands in for live.
  // The Mod button's ring and green: you're set to Modding.
  function modRinged() {
    return EMBED && myStatus === "modding";
  }
  // What the Mod button shows: "sword" / "hammer" while Modding, else "pic" (or "letter").
  function modIcon() {
    if (modRinged()) return isLeadFor(modOwner()) ? "hammer" : "sword";
    return me && pics[me.login] ? "pic" : "letter";
  }
  async function checkLive(login) {
    if (liveChecking.has(login)) return;
    liveChecking.add(login);
    try {
      const r = await helix(`/streams?user_login=${encodeURIComponent(login)}`);
      const live = r.ok ? !!(await r.json()).data?.[0] : !!liveOf[login]?.live;
      const was = liveOf[login]?.live;
      liveOf[login] = { live, at: Date.now() };
      if (live !== was) render();
    } catch {
      liveOf[login] = { live: !!liveOf[login]?.live, at: Date.now() };
    } finally {
      liveChecking.delete(login);
    }
  }
  if (!LIVECHAT) setInterval(() => ready && drawDots(), 30000); // the 5-minute glow fades with time
  if (EMBED) setInterval(() => me && modOwner() && modRinged() !== modBtn.classList.contains("mod-btn--live") && render(), 30000);
  let reactionsTimer = 0; // takes a reaction away 3 minutes after it came
  function modPanel() {
    const owner = modOwner();
    const panel = el("div", "panel mod");
    if (!owner) {
      panel.append(el("p", "panel__sub", "Open a stream you mod for. Once you and the streamer have added each other, their feed and your messages with them show up here."));
      panel.append(cardList());
      return panel;
    }
    // On their stream you're locked to them: their photo and name, no picker. Off it (no
    // streamer here who's a connection), pick whose.
    const locked = !!tabChannel && tabChannel === owner;
    const head = el("div", "mod__head");
    // Their picture and name are a link to their Twitch channel (a new tab).
    const link = el("a", "mod__link");
    link.href = `https://www.twitch.tv/${encodeURIComponent(owner)}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.title = `Open twitch.tv/${owner}`;
    if (pics[owner]) {
      // No ring: their status shows as the little pixel person beside their name.
      const img = el("img", "mod__pic");
      img.src = pics[owner];
      img.alt = "";
      link.append(img);
    }
    const able = connections.filter((c) => c.mutual).map((c) => c.login);
    const modFor = modLists?.modFor || [];
    const choices = [...able.filter((l) => modFor.includes(l)), ...able.filter((l) => !modFor.includes(l))];
    // The top bar picks among the channels you mod; the drop-down is only for when Twitch
    // hasn't said of any.
    if (!locked && choices.length > 1 && !modChannels().length) {
      const pick = el("select", "mod__pick");
      pick.title = "Whose stream";
      pick.replaceChildren(...choices.map((l) => new Option(l, l)));
      pick.value = owner;
      pick.addEventListener("change", () => {
        svPicked = pick.value;
        watching = ""; // picked by hand: stop following the tab until it changes channel
        render();
      });
      head.append(pick);
    } else {
      const name = el("span", "mod__name", owner);
      if (colorOf(owner)) name.style.color = colorOf(owner);
      link.append(name);
    }
    if (link.childNodes.length) head.prepend(link);
    const c = conn(owner);
    // Their status, as the same pixel person (with a sword for Available mod) as yours.
    if (c?.mutual) {
      const status = !c.online ? "offline" : c.idle ? "idle" : c.modding ? "modding" : "online";
      const mark = el("span", `presence presence--${status} mod__status`);
      mark.title = `${owner}: ${status === "offline" ? "offline in StreamerSpace" : STATUS[status].label}`;
      mark.setAttribute("aria-label", mark.title);
      head.append(mark);
    }
    head.append(el("span", `mod__where${locked ? " mod__where--here" : ""}`, locked ? "On this stream" : c?.online ? "online" : "Not the stream you're on"));
    panel.append(head);

    // Send: always to them, so no "Send to".
    if (c?.mutual) panel.append(composer(owner, true, true));

    // Their feed (Streamer View), drawn by drawStreamerView after this is on the page.
    panel.append(svEl);

    // Their reactions to what you sent: just the heading, unless they've reacted in the
    // last 3 minutes; each reaction shows for 3 minutes, then goes.
    const REACTION_MS = 3 * 60 * 1000;
    const reacted = Object.entries(sent)
      .filter(([, q]) => q.to === owner && q.answer && !q.gone && Date.now() - q.answer.at < REACTION_MS)
      .sort((a, b) => b[1].answer.at - a[1].answer.at)
      .slice(0, MAX_REACTIONS);
    clearTimeout(reactionsTimer);
    if (reacted.length) {
      const next = Math.min(...reacted.map(([, q]) => q.answer.at)) + REACTION_MS - Date.now();
      reactionsTimer = setTimeout(() => view === "mod" && render(), Math.max(1000, next + 50));
    }
    const rx = el("div", `mod__reactions${reacted.length ? "" : " mod__reactions--none"}`);
    rx.append(el("div", "mod__label", "Their reactions"));
    for (const [, q] of reacted) {
      const row = el("div", "mod__rx");
      const icon = el("span", `log__icon answer--${q.answer.code}`);
      icon.innerHTML = svg((ANSWERS[q.answer.code] || ANSWERS.c).icon, 13);
      row.append(icon, el("b", null, said(q.answer)), el("span", "mod__rxq", q.text), el("span", "sv__ago", ago(q.answer.at)));
      rx.append(row);
    }
    panel.append(rx);

    // The rest of your thread with them: private chat, what's waiting from them, history.
    panel.append(personPanel(owner, true));

    const others = Object.keys(inbox).filter((id) => inbox[id].from !== owner && !inbox[id].done).sort((a, b) => inbox[b].at - inbox[a].at);
    if (others.length) {
      panel.append(el("div", "mod__label", "Waiting from others"), inboxList(others));
    }
    return panel;
  }

  // inMod: just the private-chat button, what's waiting and the history (Mod has the rest).
  function personPanel(login, inMod = false) {
    const c = conn(login) || { login, mutual: false, online: false };
    const panel = el("div", "panel person");
    const head = el("div", "person__head");
    if (pics[login]) {
      const img = el("img", "person__pic");
      img.src = pics[login];
      img.alt = "";
      head.append(img);
    }
    const name = withBadge(el("span", "person__name", login), login);
    if (colorOf(login)) name.style.color = colorOf(login);
    head.append(name, el("span", `person__state${c.idle ? " person__state--idle" : c.online ? " person__state--on" : ""}`, !c.mutual ? "hasn't added you yet" : c.idle ? `idle${c.since ? ` · online since ${clock(c.since)}` : ""}` : whenWords(c) || (c.online ? "online" : "offline")));
    if (!inMod) panel.append(head);
    if (c.mutual && !inMod) panel.append(composer(login));
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

    const fromThem = Object.keys(inbox).filter((id) => inbox[id].from === login && !inbox[id].done).sort((a, b) => stageFor(inbox[b]) - stageFor(inbox[a]) || inbox[b].at - inbox[a].at);
    if (fromThem.length) panel.append(inboxList(fromThem));

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
      out.append(el("span", `receipt${q.seenAt ? " receipt--seen" : ""}`, q.seenAt ? "✓ Seen" : q.withdrawn ? "Taken back" : q.dismissed ? "Dismissed" : "Not seen yet"));
    } else {
      out.append(el("span", "receipt", q.withdrawn ? "Taken back" : mine ? (q.seen ? "Dismissed" : "Waiting for their answer") : "Dismissed"));
    }
    body.append(out);
    row.append(body, closeButton(() => setUi(id, { gone: true }), "Clear from history"));
    return row;
  }

  // "online since 9:05 PM", "last online at 9:05 PM" (or "yesterday at…", "3 d ago").
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  function whenWords(c) {
    if (c?.online && c.since) return `online since ${clock(c.since)}`;
    if (!c?.online && c?.last) {
      const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(c.last).setHours(0, 0, 0, 0)) / 86400000);
      return days <= 0 ? `last online at ${clock(c.last)}` : days === 1 ? `last online yesterday at ${clock(c.last)}` : `last online ${ago(c.last)}`;
    }
    return "";
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
  // ===== StreamerSpace's settings (side panel only) =========================================
  // The Chrome extension's switches, Refresh Twitch, and Back up / Restore, on a page of
  // their own here (the gear in the bottom-right corner). The extension keeps them, so this
  // asks its side panel page (hub-panel.js) over postMessage and tells it what changes.
  let ext = null; // { features: [{ key, label }], off: [keys] } once the extension answers
  let extAskedAt = 0;
  let extChanged = false;
  let extNote = "";
  const toExt = (m) => parent.postMessage(m, "*");
  function gotExt(m) {
    if (m?.t === "ext-settings") ext = { features: m.features || [], off: m.off || [] };
    else if (m?.t === "ext-backup" && m.data) {
      const blob = new Blob([JSON.stringify(m.data, null, 1)], { type: "application/json" });
      const a = el("a");
      a.href = URL.createObjectURL(blob);
      a.download = `StreamerSpace backup ${String(m.data.saved || "").slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      extNote = `Saved ${m.count} thing${m.count === 1 ? "" : "s"} to ${a.download} in your downloads.`;
    } else if (m?.t === "ext-restored") {
      extNote = m.error ? `That isn't a StreamerSpace backup (${m.error}).` : `Restored ${m.count} thing${m.count === 1 ? "" : "s"}.`;
      if (!m.error) extChanged = true;
    } else return;
    if (view === "extsettings") render();
  }
  function extSettingsPanel() {
    const panel = el("div", "panel msgs xset");
    panel.append(el("div", "panel__head", "Settings"));
    if (!ext) {
      if (!extAskedAt) {
        extAskedAt = Date.now();
        toExt({ t: "ext-get" });
        setTimeout(() => view === "extsettings" && !ext && render(), 1500);
      }
      panel.append(el("p", "panel__sub", Date.now() - extAskedAt < 1400 ? "Loading…" : "Update StreamerSpace (the Chrome extension) to change its settings here."));
      return panel;
    }
    panel.append(el("div", "msgs__label", "StreamerSpace features"));
    const list = el("div", "xset__list");
    if (!ext.features.length) list.append(el("p", "panel__sub", "Open or refresh a Twitch tab once, then the switches show here."));
    for (const { key, label } of ext.features) {
      const row = el("label", "set__row");
      const box = el("input", "set__switch");
      box.type = "checkbox";
      box.checked = !ext.off.includes(key);
      box.addEventListener("change", () => {
        ext.off = box.checked ? ext.off.filter((k) => k !== key) : [...ext.off, key];
        toExt({ t: "ext-set", off: ext.off });
        extChanged = true;
        render();
      });
      row.append(el("span", "set__label", label), box);
      list.append(row);
    }
    panel.append(list);
    const foot = el("div", "xset__foot");
    foot.append(el("span", "panel__sub", extChanged ? "Refresh Twitch to apply." : "Changes apply when you refresh Twitch."));
    if (extChanged) {
      const go = el("button", "pill xset__go", "Refresh Twitch");
      go.type = "button";
      go.addEventListener("click", () => {
        toExt({ t: "ext-refresh" });
        extChanged = false;
        render();
      });
      foot.append(go);
    }
    panel.append(foot);
    panel.append(el("div", "msgs__label", "Your saved things"));
    const keep = el("div", "xset__keep");
    const backup = el("button", "pill", "Back up");
    backup.type = "button";
    backup.addEventListener("click", () => toExt({ t: "ext-backup" }));
    const file = el("input");
    file.type = "file";
    file.accept = ".json,application/json";
    file.hidden = true;
    file.addEventListener("change", async () => {
      const f = file.files[0];
      file.value = "";
      if (!f) return;
      try {
        toExt({ t: "ext-restore", data: JSON.parse(await f.text()) });
      } catch (e) {
        extNote = `That isn't a StreamerSpace backup (${e.message}).`;
        render();
      }
    });
    const restore = el("button", "pill", "Restore");
    restore.type = "button";
    restore.addEventListener("click", () => file.click());
    keep.append(backup, restore, file);
    panel.append(keep, el("p", "panel__sub", extNote || "Phrases, notes, pins, markers and more, to a file."));
    return panel;
  }
  // The gear, in the bottom-right corner over the connection glow.
  const extGear = EMBED ? document.body.appendChild(el("button", "ext-gear")) : null;
  if (extGear) {
    extGear.type = "button";
    extGear.title = extGear.ariaLabel = "Settings";
    extGear.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor" shape-rendering="crispEdges"><path d="M6 1h4v1h-4zM2 2h2v1h-2zM6 2h4v1h-4zM12 2h2v1h-2zM2 3h12v1h-12zM3 4h10v1h-10zM3 5h10v1h-10zM1 6h5v1h-5zM10 6h5v1h-5zM1 7h5v1h-5zM10 7h5v1h-5zM1 8h5v1h-5zM10 8h5v1h-5zM1 9h5v1h-5zM10 9h5v1h-5zM3 10h10v1h-10zM3 11h10v1h-10zM2 12h12v1h-12zM2 13h2v1h-2zM6 13h4v1h-4zM12 13h2v1h-2zM6 14h4v1h-4z"/></svg>';
    extGear.addEventListener("click", () => {
      ext = null; // fresh each time it opens (clicked again, it closes: show() toggles)
      extAskedAt = 0;
      extNote = "";
      show("extsettings");
    });
  }

  // Messages (the side panel's honey tab): your one-on-one chats, then group chats, newest
  // first, each with its last line and what's unread. Opening one goes to that chat.
  function messagesPanel() {
    const panel = el("div", "panel msgs");
    panel.append(el("div", "panel__head", "Messages"));
    const lastOf = (owner) => chat[owner]?.at(-1);
    const newest = (a, b) => (lastOf(b.owner)?.at || 0) - (lastOf(a.owner)?.at || 0) || (a.with || a.owner).localeCompare(b.with || b.owner);
    const row = (r, pic, title) => {
      const last = lastOf(r.owner);
      const n = unread(r.owner);
      const b = el("button", `msgs__row${n ? " msgs__row--new" : ""}`);
      b.type = "button";
      const words = el("span", "msgs__words");
      const name = el("span", "msgs__name", title);
      if (r.direct) withBadge(name, r.with);
      if (r.direct && colorOf(r.with)) name.style.color = colorOf(r.with);
      words.append(name, el("span", "msgs__last", last ? `${last.from === me.login ? "You: " : r.direct ? "" : `${last.from}: `}${last.text}` : r.direct ? "No messages yet" : "Nothing said yet"));
      b.append(pic, words);
      const side = el("span", "msgs__side");
      if (last) side.append(el("span", "msgs__ago", ago(last.at)));
      if (n) side.append(el("span", "msgs__count", String(n)));
      b.append(side);
      b.addEventListener("click", () => {
        chatFrom = "messages";
        show("chat", r.owner);
      });
      return b;
    };

    // Groups first, then the one-on-one chats in their own dark section, one block each.
    const groups = rooms.filter((r) => !r.direct).sort(newest);
    panel.append(el("div", "msgs__label", "Groups"));
    if (!groups.length) panel.append(el("p", "panel__sub", "Group chats show up here when a streamer opens a room for one of their tags (like Mods)."));
    for (const r of groups) {
      const others = r.members.filter((m) => m.login !== me.login).slice(0, 3);
      const pic = el("span", "msgs__stack");
      for (const m of others) pic.append(personPic(m.login));
      panel.append(row(r, pic, r.owner === me.login ? `Your room · ${r.tag}` : `${r.owner}'s room · ${r.tag}`));
    }
    if (!rooms.some((r) => r.owner === me.login) && Object.keys(tags).length) {
      const open = el("button", "pill msgs__open", "Open a group room");
      open.type = "button";
      open.addEventListener("click", () => {
        chatFrom = "messages";
        show("chat", me.login);
      });
      panel.append(open);
    }

    const direct = rooms.filter((r) => r.direct).sort(newest);
    const priv = el("div", "msgs__private");
    priv.append(el("div", "msgs__label", "The DMs"));
    if (!direct.length) priv.append(el("p", "panel__sub", "Once you and someone have added each other in Connections, your private chat with them is here."));
    // Online: a green ring round their picture and "online". Not: when they last were.
    for (const r of direct) {
      const c = conn(r.with);
      const on = !!c?.online && !c.idle;
      const pic = personPic(r.with);
      if (on) pic.classList.add("msgs__pic--on");
      const b = row(r, pic, r.with);
      const name = b.querySelector(".msgs__name");
      const line = el("span", "msgs__nameline");
      name.replaceWith(line);
      line.append(name, el("span", `msgs__seen${on ? " msgs__seen--on" : ""}`, on ? "online" : c?.idle ? "idle" : (c && whenWords(c)) || "offline"));
      priv.append(b);
    }
    panel.append(priv);
    return panel;
  }

  // "Today", "Yesterday", or the date: the soft divider between days in a chat.
  function dayWords(t) {
    const d = new Date(t).setHours(0, 0, 0, 0), today = new Date().setHours(0, 0, 0, 0);
    return d === today ? "Today" : today - d === 86400000 ? "Yesterday" : new Date(t).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  }
  function chatPanel() {
    const panel = el("div", "panel chat");
    // Chat is reached from Connections, so it leads back there.
    const fromMessages = chatFrom === "messages";
    const back = el("button", "chat__back", fromMessages ? "‹ Messages" : "‹ Connections");
    back.type = "button";
    back.addEventListener("click", () => show(fromMessages ? "messages" : "people"));
    panel.append(back);
    const owner = chatRoom();
    const room = rooms.find((r) => r.owner === owner);
    const mine = rooms.find((r) => r.owner === me.login);

    const listed = rooms.filter((r) => !r.direct || r.owner === owner || chat[r.owner]?.length);
    const canOpen = !mine && Object.keys(tags).length;
    // The side panel picks chats from Messages, so no row of room pills there.
    if (!EMBED && listed.length + (canOpen ? 1 : 0) > 1) {
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
        panel.append(el("p", "panel__sub", "To talk privately with someone, open Connections and press Chat by their name. A streamer can also open a room for a tag (like Mods) and everyone in it can talk here."));
        return panel;
      }
      panel.append(el("p", "panel__sub", "Open a room for one of your tags. Everyone in it can talk to each other here, and you can read along (it stays quiet for you unless someone @mentions you)."));
      panel.append(roomPicker(null, "Open room"));
      return panel;
    }

    panel.classList.toggle("chat--dm", EMBED);
    if (EMBED) {
      // The side panel: who you're talking to, big, with their status, then a soft divider.
      const top = el("div", "dm__head");
      if (room.direct) {
        const c = conn(room.with) || {};
        const words = el("div", "dm__who");
        const name = withBadge(el("span", "dm__name", room.with), room.with);
        if (colorOf(room.with)) name.style.color = colorOf(room.with);
        words.append(name, el("span", `dm__state${c.online ? " dm__state--on" : ""}`, whenWords(c) || (c.online ? "online" : "offline")));
        top.append(personPic(room.with), words);
      } else {
        const stack = el("span", "msgs__stack");
        for (const m of room.members.filter((m) => m.login !== me.login).slice(0, 3)) stack.append(personPic(m.login));
        const words = el("div", "dm__who");
        words.append(el("span", "dm__name", room.owner === me.login ? `Your room · ${room.tag}` : `${room.owner}'s room · ${room.tag}`),
          el("span", "dm__state", `${room.members.length} ${room.members.length === 1 ? "person" : "people"} · ${room.members.filter((m) => m.online).length} online`));
        top.append(stack, words);
      }
      panel.append(top);
    }
    const head = el("div", "chat__head");
    if (EMBED) head.hidden = true;
    head.append(el("span", "chat__title", room.direct ? `Private chat · only you and ${room.with}` : room.owner === me.login ? `Your room · ${room.tag}` : `${room.owner}'s room · ${room.tag}`));
    const who = el("span", "chat__who");
    for (const m of room.members.filter((m) => !room.direct || m.login !== me.login)) {
      const dot = withBadge(el("span", `chat__member${m.online ? " chat__member--on" : ""}`, m.login), m.login);
      if (colorOf(m.login)) dot.style.color = colorOf(m.login);
      who.append(dot);
    }
    head.append(who);
    panel.append(head);

    const log = el("div", "chat__log");
    const msgs = chat[owner] || [];
    if (!msgs.length) log.append(el("p", "panel__sub chat__empty", room.direct ? `No messages yet. Say hi to ${room.with}.` : "No messages yet. Say hi."));
    let lastDay = "";
    for (const m of msgs) {
      const day = new Date(m.at).toDateString();
      if (day !== lastDay && (lastDay || EMBED)) log.append(el("div", "chat__day", EMBED ? dayWords(m.at) : new Date(m.at).toLocaleDateString()));
      lastDay = day;
      const line = el("div", `chat__msg${m.from === me.login ? " chat__msg--mine" : " chat__msg--theirs"}${mentions(m.text) && m.from !== me.login ? " chat__msg--mention" : ""}${room.direct ? " chat__msg--direct" : ""}`);
      const name = withBadge(el("span", "chat__from", m.from), m.from);
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
    // Ready to type, without scrolling the page down to the box (the top says where you are).
    setTimeout(() => document.activeElement === document.body && input.focus({ preventScroll: true }));

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
  let tagOpen = ""; // Connections: whose + (add a tag) box is open
  let newGroup = null; // Connections: the New group form ({ name, picked }) while it's open
  // Connections: one screen, top to bottom —
  //   the Twitch Space header; add someone, and anyone asking to connect;
  //   Groups: each of your tags is a group, pinned here with its people and a Message
  //     button (sending to the tag goes to everyone in it), plus its room;
  //   who's online: online first, then idle, then offline, then those who haven't added
  //     you back. Each person keeps their tags; + pins them into a group (new or old).
  function peoplePanel() {
    const panel = el("div", "panel cx");

    // ----- Header: the brand
    const head = el("div", "cx__head");
    const mark = el("img", "cx__mark");
    mark.src = "icons/ts-mark.svg";
    mark.alt = "";
    const titles = el("div", "cx__titles");
    titles.append(el("div", "cx__title", "Connections"), el("div", "cx__by", "StreamerSpace · Streamer Buddy System"));
    head.append(mark, titles);
    panel.append(head);

    // ----- Add someone, and requests
    const addCard = el("section", "cx__card cx__add");
    const form = el("form", "cx__addbar");
    const input = textBox("Add someone by Twitch name");
    input.className = "cx__addinput";
    const add = el("button", "cx__addgo", "Add");
    add.type = "submit";
    const note = el("p", "cx__note");
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
    addCard.append(form, note);
    if (requests.length) {
      addCard.append(el("div", "cx__label", `New connections · ${requests.length}`));
      for (const login of requests) {
        const row = el("div", "cx__request");
        const back = el("button", "cx__btn cx__btn--blue", "Add back");
        back.type = "button";
        back.addEventListener("click", () => relay({ t: "connect", login }));
        row.append(personPic(login), el("span", "cx__reqname", login), el("span", "cx__reqsays", "wants to connect"), back);
        addCard.append(row);
      }
    }
    addCard.append(el("p", "cx__hint", "You can reach each other once you've both added each other."));
    if (limit) {
      const used = connections.filter((c) => c.login !== owner).length;
      addCard.append(el("p", `cx__spots${used >= limit ? " cx__spots--full" : ""}`, limit === 8 ? `Top 8 · ${used} of 8 spots used` : `${used} of ${limit} spots used`));
    }
    panel.append(addCard);
    if (allowed) panel.append(allowCard());

    // ----- Groups (your tags)
    const able = connections.filter((c) => c.mutual).map((c) => c.login);
    // Your own groups, after the two Twitch fills in (when Twitch lists anyone for them).
    const autoNames = Object.entries(AUTO_GROUPS).filter(([key, tag]) => tags[tag] || modLists?.[key]?.length).map(([, tag]) => tag);
    const groupNames = [...autoNames, ...Object.keys(tags).filter((t) => !isAutoGroup(t)).sort()];
    const groupsEl = el("section", "cx__section");
    const gHead = el("div", "cx__sechead");
    gHead.append(el("span", "cx__label", groupNames.length ? `Groups · ${groupNames.length}` : "Groups"));
    if (connections.length) {
      const newBtn = el("button", "cx__btn", newGroup ? "Cancel" : "+ New group");
      newBtn.type = "button";
      newBtn.addEventListener("click", () => {
        newGroup = newGroup ? null : { name: "", picked: [] };
        render();
        if (newGroup) document.querySelector('[data-key="new-group"]')?.focus();
      });
      gHead.append(newBtn);
    }
    groupsEl.append(gHead);
    // New group: a name, then tick who's in it.
    if (newGroup) {
      const card = el("form", "cx__group cx__newgroup");
      const name = textBox("Group name (Mods, Lead mods, Tech…)", newGroup.name);
      name.dataset.key = "new-group";
      name.maxLength = 20;
      name.className = "cx__newname";
      name.addEventListener("input", () => (newGroup.name = name.value));
      const pickList = el("div", "cx__picklist");
      for (const { login } of connections) {
        const on = newGroup.picked.includes(login);
        const b = el("button", `cx__pick${on ? " cx__pick--on" : ""}`);
        b.type = "button";
        b.setAttribute("aria-pressed", String(on));
        b.append(personPic(login), el("span", null, login), el("span", "cx__tick", on ? "✓" : ""));
        b.addEventListener("click", () => {
          newGroup.picked = on ? newGroup.picked.filter((l) => l !== login) : [...newGroup.picked, login];
          render();
        });
        pickList.append(b);
      }
      const make = el("button", "cx__btn cx__btn--blue", "Make group");
      make.type = "submit";
      const words = el("p", "cx__note");
      card.append(name, el("div", "cx__label cx__picklabel", "Who's in it"), pickList, make, words);
      card.addEventListener("submit", (e) => {
        e.preventDefault();
        const tag = clean(name.value).slice(0, 20);
        if (!tag) return void (words.textContent = "Give the group a name.");
        if (!newGroup.picked.length) return void (words.textContent = "Pick at least one person.");
        for (const login of newGroup.picked) relay({ t: "tag", login, tag, on: true });
        newGroup = null;
        render();
      });
      groupsEl.append(card);
    }
    // Not allowed to see Twitch's mod lists yet (signed in before this asked): one button.
    if (!TESTING && me && !hasModScopes()) {
      const ask = el("div", "cx__group cx__allow");
      const go = el("button", "cx__btn cx__btn--blue", "Allow on Twitch");
      go.type = "button";
      go.addEventListener("click", signIn);
      ask.append(el("div", "cx__allowtext", "Fill in Your mods and Channels I mod from Twitch, so your mods are already here."), go);
      groupsEl.append(ask);
    }
    if (!groupNames.length && !newGroup) {
      groupsEl.append(el("p", "cx__hint", "Make a group (Mods, Lead mods, Tech…) with + New group, or pin someone in with the + next to their name below. Then message the whole group at once. Only you see your groups."));
    }
    for (const g of groupNames) {
      const autoKey = Object.keys(AUTO_GROUPS).find((k) => AUTO_GROUPS[k] === g);
      const members = tags[g] || [];
      const known = new Set(connections.map((c) => c.login));
      const notYet = autoKey && modLists ? modLists[autoKey].filter((l) => !known.has(l) && l !== me.login && !requests.includes(l)) : [];
      const card = el("div", "cx__group");
      const top = el("div", "cx__grouptop");
      const label = el("div", "cx__grouplabel");
      label.append(el("span", "cx__groupname", g), el("span", "cx__groupcount", `${members.length + notYet.length}`));
      if (autoKey) label.append(el("span", "cx__from", "from Twitch"));
      top.append(label);
      const reach = members.filter((l) => able.includes(l));
      const msg = el("button", "cx__btn cx__btn--blue", "Message group");
      msg.type = "button";
      msg.disabled = !reach.length;
      msg.title = reach.length ? `Send to everyone in ${g}` : "Nobody in this group has added you back yet";
      msg.addEventListener("click", () => show("ask", `#${g}`));
      const room = rooms.find((r) => !r.direct && r.owner === me.login && r.tag === g);
      const roomBtn = el("button", "cx__btn", room ? "Room" : "Open room");
      roomBtn.type = "button";
      roomBtn.title = room ? `The ${g} room: everyone in it can talk to each other` : `Open a room for ${g}, so everyone in it can talk`;
      if (room && unread(room.owner)) roomBtn.append(el("span", "pill__count", String(unread(room.owner))));
      roomBtn.addEventListener("click", () => show("chat", me.login));
      const acts = el("div", "cx__groupacts");
      acts.append(roomBtn, msg);
      top.append(acts);
      card.append(top);
      const faces = el("div", "cx__faces");
      for (const login of members) {
        const c = conn(login) || {};
        const face = el("span", `cx__face${c.online ? " cx__face--on" : ""}${c.idle ? " cx__face--idle" : ""}`);
        face.title = `${login}${c.idle ? " (idle)" : c.online ? " (online)" : ""}`;
        face.append(personPic(login), el("span", "cx__facename", login));
        if (!autoKey) {
          const x = el("button", "cx__facex", "×");
          x.type = "button";
          x.title = `Take ${login} out of ${g}`;
          x.addEventListener("click", () => relay({ t: "tag", login, tag: g, on: false }));
          face.append(x);
        }
        faces.append(face);
      }
      // From Twitch, but not connected here yet: Add sends them a request.
      for (const login of notYet) {
        const face = el("span", "cx__face cx__face--new");
        face.title = `${login} isn't connected with you yet`;
        const addBtn = el("button", "cx__faceadd", "Add");
        addBtn.type = "button";
        addBtn.title = `Ask ${login} to connect`;
        addBtn.addEventListener("click", async () => {
          addBtn.disabled = true;
          const user = TESTING ? { login } : await lookUp(login).catch(() => null);
          if (user) relay({ t: "connect", login: user.login });
        });
        face.append(personPic(login), el("span", "cx__facename", login), addBtn);
        faces.append(face);
      }
      card.append(faces);
      groupsEl.append(card);
    }
    // Rooms other people opened for a group you're in.
    const theirRooms = rooms.filter((r) => !r.direct && r.owner !== me.login);
    if (theirRooms.length) {
      const row = el("div", "cx__rooms");
      for (const r of theirRooms) {
        const b = el("button", "cx__btn", `${r.owner}'s room · ${r.tag}`);
        b.type = "button";
        if (unread(r.owner)) b.append(el("span", "pill__count", String(unread(r.owner))));
        b.addEventListener("click", () => show("chat", r.owner));
        row.append(b);
      }
      groupsEl.append(row);
    }
    panel.append(groupsEl);

    // ----- Who's online
    const names = el("datalist");
    names.id = "tag-names";
    for (const t of [...new Set([...groupNames, "Mods", "Lead mods", "Tech"])]) names.append(new Option(t));
    panel.append(names);
    const order = (c) => (!c.mutual ? 3 : c.idle ? 1 : c.online ? 0 : 2);
    const sorted = [...connections].sort((x, y) => order(x) - order(y) || x.login.localeCompare(y.login));
    const SECTIONS = [["Online", 0], ["Idle", 1], ["Offline", 2], ["Waiting for them to add you", 3]];
    for (const [label, k] of SECTIONS) {
      const people = sorted.filter((c) => order(c) === k);
      if (!people.length) continue;
      const sec = el("section", "cx__section");
      const h = el("div", "cx__sechead");
      h.append(el("span", `cx__label cx__label--${k === 0 ? "on" : k === 1 ? "idle" : "off"}`, `${label} · ${people.length}`));
      sec.append(h);
      const list = el("div", "cx__list");
      for (const c of people) personRow(list, c);
      sec.append(list);
      panel.append(sec);
    }
    if (!connections.length && !requests.length) panel.append(el("p", "cx__hint cx__empty", "Nobody yet. Add someone above."));

    // ----- Bottom: sound, sign out, build
    const foot = el("div", "cx__foot");
    const sound = el("label", "panel__check");
    const box = el("input");
    box.type = "checkbox";
    box.checked = soundOn();
    box.addEventListener("change", () => {
      put("sound", box.checked);
      if (box.checked) chime();
    });
    sound.append(box, document.createTextNode(" Sound when something arrives"));
    const out = el("button", "panel__signout", `Sign out of ${me.login}`);
    out.type = "button";
    out.addEventListener("click", signOut);
    foot.append(sound, out, el("p", "cx__build", `Build ${window.DOCK_VERSION || "?"}`));
    panel.append(foot);
    return panel;
  }

  // A picture (or first letter) for someone.
  function personPic(login) {
    const pic = el("span", "people__pic");
    if (pics[login]) {
      const img = el("img");
      img.src = pics[login];
      img.alt = "";
      pic.append(img);
    } else pic.append(el("span", "dot__letter", login[0].toUpperCase()));
    const rank = rankBadge(login, true);
    if (rank) pic.append(rank);
    return pic;
  }

  // One person in the list: picture, name and how they are (a button for your private
  // chat), their groups, + to pin them into one, and × to remove them.
  // ----- The allow list (the owner's Connections only) ----------------------------------
  // Who can use StreamerSpace's buddy system at all. Adding someone connects them to you
  // straight away (you're their first connection); taking them off signs them out.
  let allowOpen = false;
  let allowOff = ""; // asked "are you sure?" about taking this one off
  function allowCard() {
    const card = el("section", "cx__card cx__allowlist");
    const head = el("button", "cx__sechead cx__allowhead");
    head.type = "button";
    head.setAttribute("aria-expanded", String(allowOpen));
    head.append(el("span", "cx__label", `Allow list · ${allowed.length}`), el("span", "cx__allowtoggle", allowOpen ? "Hide" : "Show"));
    head.addEventListener("click", () => {
      allowOpen = !allowOpen;
      allowOff = "";
      render();
    });
    card.append(head);
    card.append(el("p", "cx__hint", "Only people on this list can sign in. Everyone you add is connected to you automatically."));
    if (!allowOpen) return card;

    const form = el("form", "cx__addbar");
    const input = textBox("Allow someone by Twitch name");
    input.className = "cx__addinput";
    input.dataset.key = "allow-add";
    const go = el("button", "cx__addgo", "Allow");
    go.type = "submit";
    const note = el("p", "cx__note");
    form.append(input, go);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const login = input.value.trim().replace(/^@/, "").toLowerCase();
      if (!/^[a-z0-9_]{2,25}$/.test(login)) return void (note.textContent = "That isn't a Twitch username.");
      if (login === me.login) return void (note.textContent = "That's you: you're always allowed.");
      if (allowed.some((a) => a.login === login)) return void (note.textContent = `${login} is already on the list.`);
      go.disabled = true;
      note.textContent = "";
      const user = await lookUp(login).catch(() => null);
      go.disabled = false;
      if (!user) return void (note.textContent = `Couldn't find ${login} on Twitch.`);
      input.value = "";
      relay({ t: "allow", login: user.login, on: true });
    });
    card.append(form, note);

    const list = el("div", "cx__list");
    const newest = [...allowed].sort((a, b) => (b.added || 0) - (a.added || 0));
    for (const a of newest) {
      const row = el("div", "people__row cx__row cx__allowrow");
      const who = el("div", "people__who");
      const words = el("span", "people__words");
      const name = el("span", "people__name", a.login);
      if (colorOf(a.login)) name.style.color = colorOf(a.login);
      words.append(name, el("span", "people__state", a.joined ? "signed up" : "hasn't signed in yet"));
      who.append(personPic(a.login), words);
      row.append(who);
      // Their spots: how many people they've added, of how many they can.
      const spots = el("div", "cx__spotset");
      const step = (by, label, title) => {
        const b = el("button", "cx__spotbtn", label);
        b.type = "button";
        b.title = title;
        b.disabled = a.limit + by < 8 || a.limit + by > 100;
        b.addEventListener("click", () => relay({ t: "allow", login: a.login, limit: a.limit + by }));
        return b;
      };
      spots.append(step(-4, "−", `${a.login} gets 4 fewer spots`), el("span", `cx__spotn${a.used >= a.limit ? " cx__spotn--full" : ""}`, `${a.used}/${a.limit}`), step(4, "+", `Give ${a.login} 4 more spots`));
      spots.title = `${a.login} has added ${a.used} of ${a.limit} people`;
      row.append(spots);
      if (allowOff === a.login) {
        const yes = el("button", "cx__btn cx__btn--bad", "Take off");
        yes.type = "button";
        yes.title = `${a.login} is signed out and can't sign in again`;
        yes.addEventListener("click", () => {
          allowOff = "";
          relay({ t: "allow", login: a.login, on: false });
        });
        const no = el("button", "cx__btn", "Keep");
        no.type = "button";
        no.addEventListener("click", () => {
          allowOff = "";
          render();
        });
        row.append(yes, no);
      } else {
        row.append(closeButton(() => {
          allowOff = a.login;
          render();
        }, `Take ${a.login} off the allow list`));
      }
      list.append(row);
    }
    if (!allowed.length) list.append(el("p", "cx__hint", "Nobody yet. Add someone above."));
    card.append(list);
    return card;
  }

  function personRow(list, { login, mutual, online, idle }) {
    const row = el("div", "people__row cx__row");
    const direct = directWith(login);
    const who = el(direct ? "button" : "div", `people__who${direct ? " people__who--chat" : ""}`);
    if (direct) {
      who.type = "button";
      who.title = `Private chat with ${login}`;
      who.addEventListener("click", () => show("chat", direct.owner));
    }
    const pic = personPic(login);
    pic.classList.add(`cx__pic${!mutual ? "" : idle ? "--idle" : online ? "--on" : "--off"}`);
    const name = el("span", "people__name", login);
    if (colorOf(login)) name.style.color = colorOf(login);
    const words = el("span", "people__words");
    words.append(name, el("span", `people__state${online && !idle ? " people__state--on" : ""}`, !mutual ? "hasn't added you yet" : idle ? "idle" : online ? "online" : "offline"));
    who.append(pic, words);
    const n = direct ? unread(direct.owner) : 0;
    if (n) who.append(el("span", "people__unread", String(n)));
    row.append(who);
    const tagsEl = el("div", "people__tags");
    for (const t of Object.keys(tags).sort().filter((t) => tags[t].includes(login))) {
      const chip = el("span", `tagchip${isAutoGroup(t) ? " tagchip--auto" : ""}`, t);
      // The Twitch groups follow Twitch, so there's nothing to take out by hand.
      if (!isAutoGroup(t)) {
        const x = el("button", "tagchip__x", "×");
        x.type = "button";
        x.title = `Take ${login} out of ${t}`;
        x.addEventListener("click", () => relay({ t: "tag", login, tag: t, on: false }));
        chip.append(x);
      }
      tagsEl.append(chip);
    }
    const plus = el("button", `people__plus${tagOpen === login ? " people__plus--on" : ""}`, "+");
    plus.type = "button";
    plus.title = `Pin ${login} into a group`;
    plus.setAttribute("aria-expanded", String(tagOpen === login));
    plus.addEventListener("click", () => {
      tagOpen = tagOpen === login ? "" : login;
      render();
      if (tagOpen) document.querySelector(`[data-key="tag-${login}"]`)?.focus();
    });
    tagsEl.append(plus);
    // The owner and the people on their allow list stay connected: only the list ends it.
    const fixed = login === owner || (me?.login === owner && allowed?.some((a) => a.login === login));
    if (login === owner) words.append(el("span", "people__first", "Your first connection"));
    row.append(tagsEl);
    if (!fixed) row.append(closeButton(() => relay({ t: "disconnect", login }), `Remove ${login}`));
    list.append(row);
    if (tagOpen === login) {
      const addTag = el("form", "tagadd");
      const box = textBox("Group name (new or existing)");
      box.dataset.key = `tag-${login}`;
      box.maxLength = 20;
      box.setAttribute("list", "tag-names");
      box.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        tagOpen = "";
        render();
      });
      const save = el("button", "cx__btn cx__btn--blue", "Pin");
      save.type = "submit";
      addTag.append(box, save);
      addTag.addEventListener("submit", (e) => {
        e.preventDefault();
        const tag = clean(box.value).slice(0, 20);
        if (tag) relay({ t: "tag", login, tag, on: true });
        box.value = "";
        tagOpen = "";
        render();
      });
      list.append(addTag);
    }
  }

  function showSignedOut(message) {
    me = null;
    socket?.close();
    socket = null;
    askBtn.hidden = modBtn.hidden = msgBtn.hidden = peopleBtn.hidden = homeChatBtn.hidden = dndBtn.hidden = quickAsk.hidden = askFull.hidden = chatBtn.hidden = statsBtn.hidden = true;
    dotsEl.replaceChildren();
    const again = el("button", "pill pill--warn pill--bad", message ? "Signed out · Sign in with Twitch" : "Sign in with Twitch");
    again.type = "button";
    again.addEventListener("click", signIn);
    peekEl.replaceChildren(again);
    setStatus("");
    const box = el("div", "signin");
    const mark = el("img", "signin__mark");
    mark.src = "icons/ts-mark.svg";
    mark.alt = "";
    box.append(mark, el("div", "signin__head", "Streamer Buddy System"), el("p", "signin__sub", "Quick questions between you and the people you've connected with."), el("p", "signin__by", "Part of StreamerSpace"));
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
    { kind: "ask", text: "Can you post the Discord link?" },
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
  const deckState = { editing: false, sent: -1, kind: "info", text: "", to: "" }; // to: picked here, this visit

  function sendTile(tile, i, to) {
    const sentOk = tile.kind === "ask"
      ? relay({ t: "ask", to, text: tile.text, options: STANDARD })
      : relay({ t: "flash", kind: tile.kind, to, text: tile.text });
    if (!sentOk) return;
    rememberTo(to);
    deckState.to = to;
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
    const to = choices.includes(deckState.to) ? deckState.to : defaultTo();
    const who = el("label", "deckp__who");
    who.append(el("span", null, "To"));
    const pick = el("select");
    for (const t of choices) pick.append(new Option(targetLabel(t), t, false, t === to));
    pick.addEventListener("change", () => (deckState.to = pick.value));
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
    if (answers.length) panel.append(answerList(answers));
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
  const IRC_URL = () => (TESTING && params.has("mock") ? `ws://${location.host}/mock/irc` : "wss://irc-ws.chat.twitch.tv:443");
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
  const LIGHT_MINUTE = (TESTING && Number(params.get("lightms"))) || 60 * 1000;
  function liveLight(login) {
    const min = liveSaid[login] ? (Date.now() - liveSaid[login]) / LIGHT_MINUTE : Infinity;
    const here = liveChatters.has(login) || (!liveListed && !liveLeft.has(login) && min <= 30);
    const chatted = min === Infinity ? "" : `chatted ${Math.max(1, Math.round(min))} min ago`;
    if (!here) return { ring: "", away: true, says: `not in chat${chatted && `, ${chatted}`}` };
    const ring = min <= 5 ? "light5" : min <= 10 ? "light10" : min <= 20 ? "light20" : min <= 30 ? "light30" : "";
    return { ring, away: false, says: chatted ? `in chat, ${chatted}` : "in chat, lurking" };
  }

  // When they were last in the chat (saved with the stream's list, for restarts). After
  // LIVE_GONE_MINUTES away, their picture leaves the bar.
  const LIVE_GONE_MINUTES = 30;
  function liveSeenNow(login) {
    liveBeen.seen ||= {};
    const before = liveBeen.seen[login] || 0;
    liveBeen.seen[login] = Date.now();
    if (Date.now() - before > 60 * 1000) put(`chatBeen-${liveChannel}`, liveBeen); // not on every redraw
  }
  const liveSeenAt = (login) => Math.max(liveBeen.seen?.[login] || 0, liveSaid[login] || 0);

  // Are they, or have they been, in the chat this stream?
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
    // Tags too: they say which messages are someone's first in the channel (custom chat
    // marks those, like Twitch does for mods).
    ws.send("CAP REQ :twitch.tv/membership twitch.tv/tags");
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
        const login = line.match(/^(?:@\S+ )?:(\w+)!\S+ JOIN /)?.[1];
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
          for (const login of names.split(" ")) {
            liveChatters.add(login);
            try {
              ownChat?.here(login); // custom chat tells raiders from people already here
            } catch {}
          }
          changed = true;
        }
        const [, tags, login, what] = line.match(/^(?:@(\S+) )?:(\w+)!\S+ (JOIN|PART|PRIVMSG) /) || [];
        if (what === "JOIN") {
          try {
            ownChat?.here(login);
          } catch {}
        }
        if (what === "PRIVMSG") {
          try {
            ownChat?.ircSaw(login); // lets custom chat check it isn't missing messages
            if (tags && /(^|;)first-msg=1(;|$)/.test(tags)) ownChat?.firstChat(tags.match(/(?:^|;)id=([^;]+)/)?.[1]);
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
  const MOCK = TESTING && params.has("mock"); // dev/mock-twitch.js
  let ownChat = null;
  let ownChatWatch = 0;
  let ownChatStartTimer = 0;
  let chatTurn = 0; // anything still waiting from an earlier attempt is ignored

  const chatToken = () => get("chatToken", "");
  const chatUrls = () => (MOCK
    ? { helix: `${location.origin}/mock/helix`, eventsub: `ws://${location.host}/mock/ws`, validate: `${location.origin}/mock/validate`, history: `${location.origin}/mock/history`, otherEmotes: false }
    : { helix: HELIX, eventsub: "wss://eventsub.wss.twitch.tv/ws", validate: "https://id.twitch.tv/oauth2/validate", history: "https://recent-messages.robotty.de/api/v2/recent-messages", otherEmotes: true });

  // The two chats are two layers in the chat area, each made once and then kept: custom
  // chat, and Twitch's own (its embedded chat). Switching between them only changes which
  // one shows, so neither loses what it had. Twitch's is loaded in the background as soon
  // as the dock opens (unless it's the pretend Twitch), so it already has everything since
  // then the first time it's needed, even if custom chat fails.
  let ownLayer = null;
  let twitchLayer = null;
  let twitchStrip = null;
  function chatLayers() {
    if (ownLayer) return;
    const box = document.getElementById("live");
    ownLayer = el("div", "live__layer live__layer--own");
    twitchLayer = el("div", "live__layer live__layer--twitch live__layer--off");
    twitchStrip = el("div", "live__stripSlot");
    twitchLayer.append(twitchStrip);
    box.replaceChildren(ownLayer, twitchLayer);
  }
  function twitchFrame() {
    chatLayers();
    if (twitchLayer.querySelector(".live__frame")) return;
    const frame = el("iframe", "live__frame");
    frame.title = `${liveChannel}'s Twitch chat`;
    frame.src = `https://www.twitch.tv/embed/${liveChannel}/chat?parent=${encodeURIComponent(location.hostname)}&darkpopout`;
    twitchLayer.append(frame);
  }
  function showLayer(which) {
    chatLayers();
    ownLayer.classList.toggle("live__layer--off", which !== "own");
    twitchLayer.classList.toggle("live__layer--off", which !== "twitch");
  }
  function showTwitchChat(strip) {
    twitchFrame();
    twitchStrip.replaceChildren(...(strip ? [chatStrip(strip)] : []));
    showLayer("twitch");
  }

  // The slim line above Twitch's chat, when there's something to say about custom chat.
  function chatStrip({ text, unsent, label, run, big, head, other }) {
    // Custom chat not OK'd yet: a card that can't be missed, not the slim line.
    if (big) {
      const card = el("div", "live__card");
      const go = el("button", "live__cardBtn", label);
      go.type = "button";
      go.addEventListener("click", run);
      card.append(el("div", "live__cardHead", head), el("p", "live__cardText", text), go);
      if (other) {
        const no = el("button", "live__stripBtn live__cardOther", other.label);
        no.type = "button";
        no.addEventListener("click", other.run);
        card.append(no);
      }
      return card;
    }
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
  // Custom chat carries on underneath (out of sight), so going back to it loses nothing.
  function chooseTwitchChat() {
    put("ownChatPicked", "twitch");
    showTwitchChat({ text: "Using Twitch's chat.", label: "Use custom chat", run: backToOwnChat });
    if (settingsEl && !settingsEl.hidden) drawSettings();
  }
  // Back to custom chat: straight back to it, as it was, if it's still running; otherwise
  // it starts again (with the last 50 messages).
  function backToOwnChat() {
    put("ownChatPicked", "");
    if (ownChat) {
      showLayer("own");
      if (settingsEl && !settingsEl.hidden) drawSettings();
    } else tryOwnChatAgain();
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
      if (!get("ownChat", true)) return showTwitchChat();
      if (!window.OwnChat) return showTwitchChat({ text: "Custom chat didn't load, so this is Twitch's chat.", label: "Reload", run: () => location.reload() });
      if (get("ownChatPicked", "") === "twitch") return showTwitchChat({ text: "Using Twitch's chat.", label: "Use custom chat", run: backToOwnChat });
      const failed = get("ownChatFailed", null);
      if (failed && Date.now() - failed.at < OWNCHAT_RETRY_AFTER_MS) {
        return showTwitchChat({ text: `Using Twitch's chat because ${failed.reason} earlier.`, label: "Try custom chat again", run: tryOwnChatAgain });
      }
      ownChatStartTimer = setTimeout(() => turn === chatTurn && !ownChat?.ready && chatFallback("custom chat took too long to connect"), OWNCHAT_START_MS);
      const problem = await chatSigninProblem();
      if (turn !== chatTurn) return;
      if (problem) {
        clearTimeout(ownChatStartTimer);
        return showTwitchChat({ big: true, head: "Turn on custom chat", text: "This is Twitch's plain chat. Custom chat needs your OK on Twitch once.", label: "Sign in with Twitch", run: ownChatSignIn,
          other: { label: "Keep Twitch's chat", run: chooseTwitchChat } });
      }
      chatLayers();
      ownLayer.replaceChildren();
      showLayer("own");
      ownChat = window.OwnChat.start({
        box: ownLayer,
        me: MOCK ? { ...me, id: me.id || "1" } : me,
        channel: liveChannel,
        channelId: liveChannel === me.login ? (me.id || (MOCK ? "1" : "")) : "",
        token: chatToken,
        clientId: TWITCH_CLIENT_ID,
        urls: chatUrls(),
        isConnection: (login) => trusted().includes(login),
        onFail: (reason) => turn === chatTurn && chatFallback(reason),
        onChoose: chooseTwitchChat,
        onSignIn: ownChatSignIn, // to add a permission it would like (EXTRA_SCOPES)
        onBadges: noteLead,
        pretend: SANDBOX, // the public demo: links to Twitch say what they'd do instead
      });
      if (location.hostname === "localhost") window.__ownChat = ownChat;
      for (const login of liveChatters) ownChat.here?.(login); // who was already here
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
    followStream();
    document.getElementById("live").hidden = false;
    chatLayers();
    if (!MOCK && get("ownChat", true)) twitchFrame(); // ready in the background, with history
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

  // The ?t= gets past GitHub's 10-minute copy. Only a half-typed message holds the
  // reload back (in OBS the chat box keeps focus all stream, so focus alone can't),
  // and then it tries again every few seconds until the box is empty.
  let updateWaiting = false;
  async function checkForUpdate() {
    if (DEMO || !window.DOCK_VERSION) return;
    try {
      if (!updateWaiting) {
        const v = (await (await fetch(`version.txt?t=${Date.now()}`, { cache: "no-store" })).text()).trim();
        if (!v || v === window.DOCK_VERSION) return;
        updateWaiting = true;
      }
      const typing = [...document.querySelectorAll("input[type=text], textarea")].some((i) => i.value.trim());
      if (!typing) return location.reload();
      setTimeout(checkForUpdate, 5000);
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
    else if (m.t === "withdraw" && q) gotQuestion({ ...q, withdrawn: now });
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
  dndBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openSettings(false);
    if (dndOn()) setDnd(0); // on: off it goes
    else openDndMenu(dndMenu.hidden); // off: how long?
  });
  // The chat dock's chat bubble: close whatever's open (a menu, Settings, the full list)
  // and go straight back to the stream chat.
  homeChatBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openSettings(false);
    showAll = false;
    view = HOME_VIEW;
    render();
    main.scrollTop = 0;
  });
  chatBtn.addEventListener("click", () => show("chat", chatRoom()));
  statsBtn.addEventListener("click", () => show("stats", statsWho()));
  msgBtn.addEventListener("click", () => show("messages"));
  quickAsk.addEventListener("submit", (e) => {
    e.preventDefault();
    const question = clean(quickText.value);
    if (!question || !relay({ t: "ask", ...sendTo(quickTo.value), text: question, ...askOrSay(question) })) return;
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
  modBtn.addEventListener("click", (e) => {
    view = "mod";
    render();
    main.scrollTop = 0;
    // Showing your picture (not Available mod): it also opens your status menu, to change it.
    if (modBtn.classList.contains("mod-btn--off")) {
      e.stopPropagation(); // or the click-elsewhere closer would shut it straight away
      openPresence(presenceMenu.hidden);
    }
  });
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
  let updatesOn = false;
  async function start() {
    // Updates are checked from the start, signed in or not.
    if (!updatesOn) {
      updatesOn = true;
      setInterval(() => !updateWaiting && checkForUpdate(), UPDATE_CHECK_MS);
    }
    if (DECK) document.body.classList.add("deck");
    // The space backdrop (as on the demo site), behind everything: the streamer's chat dock
    // too, with its chat as dark glass over it (dock.css, "The streamer's chat dock in space").
    if (!document.getElementById("space")) {
      const space = el("div", "space");
      space.id = "space";
      space.setAttribute("aria-hidden", "true");
      space.append(el("div", "space__planet"), el("div", "space__mark"));
      // The mod side panel: Tom's head, upside down, drifting edge to edge like an old DVD
      // logo, so faint it's barely there.
      if (EMBED) bounceTom(space);
      space.append(el("div", "space__pixels")); // retro pixel stars (dock.css)
      document.body.prepend(space);
      document.body.classList.add("has-space");
    }
    if (POPOUT) document.body.classList.add("popout");
    if (EMBED) document.body.classList.add("embed");
    if (LIVECHAT) document.body.classList.add("livechat");
    // The OBS chat dock: a dim planet, half out of the bar.
    if (LIVECHAT && !document.querySelector(".bar__space")) {
      const deco = el("div", "bar__space");
      deco.setAttribute("aria-hidden", "true");
      deco.append(el("div", "bar__planet"));
      document.querySelector(".bar").prepend(deco);
    }
    // The chat dock keeps one size: everything that comes in (the newest question or
    // answer, quick info, !vanish notes, flagged lines) shows in one fixed-height slot under
    // the bar, scrolling if there's more than fits, and pages opened from the bar
    // (Connections, Stats, the full list) lie over the chat. The chat never moves.
    if (LIVECHAT && !document.getElementById("slot")) {
      const slot = el("section", "slot");
      slot.id = "slot";
      slot.setAttribute("aria-label", "What's come in");
      slot.append(el("div", "slot__empty"), peekEl, flashesEl, pinsEl);
      document.querySelector(".bar").after(slot);
      // More than fits: a small "▾ 2 more" tag on the slot's bottom edge (click: scroll there).
      const more = el("button", "slot__more");
      more.type = "button";
      more.hidden = true;
      more.addEventListener("click", () => slot.scrollBy({ top: slot.clientHeight - 8, behavior: "smooth" }));
      slot.after(more);
      const items = () => [...slot.querySelectorAll(":scope > .peek--on, .flashes > *, .pins > *")];
      const countMore = () => {
        const bottom = slot.getBoundingClientRect().bottom;
        const hidden = items().filter((i) => i.getBoundingClientRect().top > bottom - 6).length;
        more.hidden = !hidden;
        more.textContent = `▾ ${hidden} more`;
        if (hidden) more.style.top = `${Math.round(bottom - 20)}px`;
      };
      new MutationObserver(countMore).observe(slot, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
      slot.addEventListener("scroll", countMore);
      addEventListener("resize", countMore);
      // Pages from the bar sit just under the slot, over the chat (dock.css, --under).
      const under = () => document.body.style.setProperty("--under", `${Math.round(slot.getBoundingClientRect().bottom)}px`);
      under();
      new ResizeObserver(under).observe(document.querySelector(".bar"));
      addEventListener("resize", under);
    }
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
    if (PINGS_HERE) setInterval(() => pingCheck() && render(), 1000);
  }

  start();
})();

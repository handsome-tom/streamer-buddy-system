// Streamer Buddy System relay: a Cloudflare Worker with one Durable Object,
// the hub, that every Streamer Buddy System page (the streamer's OBS dock and
// the hub in Twitch Space's side panel) keeps a WebSocket open to.
//
// Signing in: a page's first message is { t: "auth", token } with its Twitch
// sign-in. The hub asks Twitch who that is (id.twitch.tv/oauth2/validate) and
// only accepts sign-ins made for our own Twitch app, so who sent something
// always comes from Twitch, never from the message.
//
// Allow list: when OWNER_LOGIN is set (wrangler.toml), only the owner and the people on
// the owner's allow list can sign in; anyone else is told so and turned away (close code
// 4003). Everyone on the list is connected to the owner both ways, automatically, as
// their first connection (MySpace's Tom), and that connection can't be removed by either
// side: taking someone off the allow list is what ends it (and signs them out). The
// first time the list is needed it starts with everyone who already has an account, so
// switching it on locks nobody out.
//
// Top 8: with an owner, everyone else can add up to 8 people (the owner doesn't count,
// like Tom). A 9th is refused with error "topeight" and the dock shows Tom saying so; the
// owner can give someone more from the allow list (limit). Requests from others still
// arrive; adding one back counts.
//
// Asking to join: anyone turned away is remembered (newest MAX_ASKS) so the owner sees
// them on the allow list with Allow and Dismiss. Allowing someone clears their ask.
//
// Kept as "allow": { logins: [login], added: { login: at }, limits: { login: n },
// asks: { login: { at, first, tries } } }.
// Without OWNER_LOGIN (the demo, local testing) anyone can sign in, as before.
//
// Invite links: anyone can make a link (invite) that connects whoever opens it and signs in
// to them, both ways at once, so they can ask each other straight away instead of each
// adding the other by name. A link works once, for a week; up to MAX_OPEN_INVITES unused at
// a time. Top 8 still counts on both sides. With an owner, the person invited still needs to
// be on the allow list: if they aren't, their ask to join says who invited them ("by"), and
// their page keeps the link and uses it once they're allowed. Kept as "inv:<code>":
// { from, at, used: { by, at } | null }, and each person's codes as their user's "invites".
//
// Connections: each person's list of who they've added. Two people can ask
// each other only once both have added each other ("mutual"); until then the
// other side sees the request. Whether someone's online is only shared
// between mutual connections.
//
// Questions: { id, from, to, text, at, options, answer: { code, text, at } | null,
// dismissed, seenAt, group, nudges, nudgedAt, warns, warnedAt }. Asking everyone ("to": "*") makes one copy per
// mutual connection, sharing a group id; asking a tag ("#Mods") does the same
// for the people in it. toTag says who it went to ("everyone", or the tag).
//
// Rooms: each person (usually a streamer) can have one chat room, open to one
// of their tags (e.g. Mods): they and the mutual connections in that tag can
// talk there. Messages are kept a week (the last 50 come with the state).
//
// Private chats: any two mutual connections also have a chat only they can see,
// whoever they are (two streamers, say). It works like a room whose owner is
// "@alice+bob", the two logins sorted; a login can't contain "@", so it can't
// clash with a room. It ends if either of them removes the other.
//
// Flashes: quick things for the streamer's bar, never stored, so only people
// online get them. "info" is a fast note (shows 2 minutes), "love" a love note
// (30 seconds), both to a person, tag or everyone. "chat" flags a line of
// Twitch chat in a channel: its owner gets it in their bar, and that channel's
// mutual connections get it so the line can glow in their chat, in the colour
// of whoever flagged it.
//
// Stats: Twitch keeps no viewer history and keeps subs private, so a streamer's
// own panel sends its numbers here while it's open: a sample a minute, and
// events as they happen. Only your own panel can write your stats. They're
// recorded from then on, and shared with your mutual connections only if you
// switch sharing on. Daily viewer figures are kept 40 days.
//
// Tags: each person's own labels for their connections ({ "Mods": [logins] }),
// e.g. Mods, Lead mods, Tech; only they see them. options are the answer buttons the asker chose: any of
// the six standard ones by letter (y n m s o t) and their own, as "+label"; a
// typed reply ("c") is always allowed. A question without options (from before
// options) offers the six standard ones. Answering with your own option is
// code "x" with its label as the text. Only the person asked can answer or dismiss; only the
// asker can mark the answer seen. Kept a week, and waiting here for anyone
// who's offline, so nothing's lost while OBS is closed.
//
// Plain messages: a question with note: true is something said, not asked. It
// has no answer buttons; the person it went to can mark it seen (the sender hears)
// or type a reply. It doesn't count towards the unanswered-questions limit.
//
// Status: what your connections see you as: "modding" (the default: online and ready to
// mod; connections get modding: true), "online" (online, not modding), "idle", or
// "offline" (shown as offline even while connected; things still reach you). Kept
// on your account, so it stays until you change it. The relay also keeps when you came
// online and when you were last online (closing your last page, or going Offline), and
// your mutual connections get them as each connection's "since" and "last".
//
// Messages from a page:
//   auth { token, invite }  connect { login }        disconnect { login }
//   invite {}               make an invite link; answered with invite { code, expires }
//   redeem { code }         use someone's invite link; answered with redeemed { from }
//   ask { to, text, options, note, online }  answer { id, code, text }  dismiss { id }
//     (online, with "*" or a "#tag": only those online right now)
//   withdraw { id }         take back your own question or message before it's answered
//   nudge { id, warn }      remind them of your unanswered question (up to 3; warn: past the
//                           limits, as a warning; see nudge())
//   status { status }       "online", "modding", "idle" or "offline"
//   tag { login, tag, on }  put a connection in (or out of) one of your tags
//   room { tag }            open your chat room to one of your tags (null closes it)
//   say { owner, text }     post in someone's room (yours: owner is you)
//   unflash { id }          clear a pinned flagged line, for everyone who has it; or take
//                           back your own quick note or !vanish (while it's still showing)
//   note { channel, chatter, chatterName, text, body, color, at }  a note on a line of a channel's
//                           chat (at: a VOD comment's moment, ms); see Chat notes below
//   notes { channel, from, to }  a VOD's notes (ms, its start and end); answered with notes { list }
//   unnote { id, channel, at }  take back your own note
//   flash { kind, to, text, chatter, color, channel }  something quick that
//                           shows for a moment; see Flashes below
//   statsShare { on }       share your stream stats with your connections
//   sample { s }            your panel's latest numbers; see Stats below
//   statEvent { kind, n, who, viewers }  a sub, gift, cheer, follow or raid
//   view { v }              what your OBS dock shows now (null: stop sharing); see Streamer View below
//   seen { id }
//   allow { login, on }     the owner only: put someone on (or take them off) the allow list
//   allow { login, limit }  the owner only: how many people they can add (8 to 100)
//   modfor { list }         the channels you mod (from your own Twitch sign-in), so your mutual
//                           connections' panels can show who mods a stream they're on
// Messages to a page:
//   state { me, status, since, connections, requests, tags, questions, rooms, chat, statsOn, stats }   (on sign-in, and whenever
//                                                       connections or who's online change)
//   q { q }                 a question that's new or changed
//   msg { m }               a new chat message { id, owner, from, text, at }
//   flash { f }             a flash { id, kind, from, to, text, chatter, color, channel, at };
//                           a flagged line also has chatterName, chatterColor, emotes { name: picture }
//   unflash { id }          a pinned flagged line was cleared
//   note { n }              a new chat note { id, channel, chatter, chatterName, text, from, body, at, color }
//   notes { channel, from, to, list }  a VOD's chat notes
//   unnote { id }           a chat note was taken back
//   flashed { kind, reached }  how many people yours reached
//   stats { owner, s }      someone's worked-out stats changed
//   view { owner, v }       what a connection's OBS dock shows now (v null: it closed)
//   invite { code, expires } your new invite link's code
//   redeemed { from }       you used from's invite: you're connected both ways
//   invited { login }       someone used your invite link
//   error { why }           why "invite" has detail: what was wrong with the link
// A plain "ping" gets "pong" without waking the hub (keeps idle pages cheap).
//
// Streamer View: a streamer's OBS dock sends a summary of what it shows whenever that
// changes: { glow, waiting, answers, notes, chat, dnd }. It's kept as "v:<login>" while that
// dock is connected and goes to their mutual connections (state's "views", and "view"
// as it changes), unless they've set themselves to Offline. When the last dock that sent
// one closes, it's dropped and connections get v: null.

import { lookup } from "./lookup.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TOP_EIGHT = 8; // people anyone but the owner can add, unless the owner gives them more
const MAX_LIMIT = 100;
const MAX_ASKS = 50; // people turned away, kept for the owner to allow
const MAX_MOD_FOR = 300; // channels someone mods, as shared with their connections
const MAX_LEN = 200;
const INVITE_MS = 7 * 24 * 60 * 60 * 1000; // how long an invite link works
const MAX_OPEN_INVITES = 20; // unused invite links one person can have at a time
const INVITE_LETTERS = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i: easy to read out
const INVITE_RE = /^[a-hj-km-np-z2-9]{10}$/;
const inviteCode = () => [...crypto.getRandomValues(new Uint8Array(10))].map((b) => INVITE_LETTERS[b % INVITE_LETTERS.length]).join("");
const MAX_FLAGGED_LEN = 500; // a whole Twitch chat message
const PIN_MS = 5 * 60 * 1000;
const SENT_FLASH_MS = 3 * 60 * 1000; // how long a quick note or !vanish can be taken back
const MAX_PIN_EMOTES = 30;
const EMOTE_HOSTS = ["static-cdn.jtvnw.net", "cdn.betterttv.net", "cdn.frankerfacez.com", "cdn.7tv.app"];
const MAX_OPEN_PER_PAIR = 3;
const MAX_ASKS_PER_MINUTE = 10;
const STANDARD = ["y", "n", "m", "s", "o", "t"];
const ALWAYS_ANSWERS = ["t", "y", "n", "m"]; // answerable on any question (dock.js STREAMER_ANSWERS)
const MAX_OPTIONS = 8;
const MAX_OPTION_LEN = 30;
const MAX_TAGS = 12;
const MAX_TAG_LEN = 20;
const MAX_SAY_LEN = 500;
const MAX_SAYS_PER_MINUTE = 20;
const CHAT_BACKLOG = 50;
const MAX_LOVE_LEN = 80;
const MAX_FLASHES_PER_MINUTE = 20;
const STAT_DAYS_KEPT = 40;
const MAX_VIEW_ITEMS = 12;
const MAX_NUDGES = 3;
const NUDGE_GAP_MS = 15 * 1000;
const WARN_GAP_MS = 30 * 1000;
const NOTE_MS = 60 * 24 * 60 * 60 * 1000; // chat notes: as long as Twitch keeps a VOD at most
const MAX_NOTE_LEN = 300;
const MAX_NOTES_PER_MINUTE = 20;
const MAX_NOTES_SENT = 1000; // to one VOD

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      return env.HUB.get(env.HUB.idFromName("hub")).fetch(req);
    }
    if (url.pathname.startsWith("/api/")) return lookup(req, env, url); // StreamSpace's public lookups (lookup.js)
    return new Response("Streamer Buddy System relay", { headers: { "content-type": "text/plain" } });
  },
};

export class Hub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({});
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const who = ws.deserializeAttachment() || {};
    if (m.t === "auth") return this.auth(ws, m.token, m.invite);
    if (!who.login) return this.send(ws, { t: "error", why: "Not signed in" });
    try {
      if (m.t === "connect") await this.setConnection(who.login, m.login, true);
      else if (m.t === "disconnect") await this.setConnection(who.login, m.login, false);
      else if (m.t === "ask") await this.ask(ws, who, m);
      else if (m.t === "status") await this.setStatus(who.login, m);
      else if (m.t === "tag") await this.setTag(who.login, m);
      else if (m.t === "room") await this.setRoom(who.login, m);
      else if (m.t === "say") await this.say(ws, who, m);
      else if (m.t === "flash") await this.flash(ws, who, m);
      else if (m.t === "unflash") await this.unflash(who, m);
      else if (m.t === "note") await this.note(ws, who, m);
      else if (m.t === "notes") await this.notes(ws, who, m);
      else if (m.t === "unnote") await this.unnote(who, m);
      else if (m.t === "statsShare") await this.statsShare(who.login, m);
      else if (m.t === "sample") await this.sample(who.login, m.s);
      else if (m.t === "statEvent") await this.statEvent(who.login, m);
      else if (m.t === "view") await this.setView(ws, who, m.v);
      else if (m.t === "answer") await this.answer(ws, who, m);
      else if (m.t === "dismiss") await this.update(ws, who, m.id, (q) => q.to === who.login && !q.answer && !q.dismissed, (q) => (q.dismissed = Date.now()));
      // Taking back your own question or message, while it's still waiting.
      else if (m.t === "withdraw") await this.update(ws, who, m.id, (q) => q.from === who.login && !q.answer && !q.dismissed && !q.withdrawn && !(q.note && q.seenAt), (q) => (q.withdrawn = Date.now()));
      // Seen: the asker, of an answer; or the person a plain message went to.
      else if (m.t === "nudge") await this.nudge(ws, who, m.id, !!m.warn);
      else if (m.t === "allow") await this.setAllowed(who.login, m);
      else if (m.t === "modfor") await this.setModFor(who.login, m.list);
      else if (m.t === "invite") await this.makeInvite(ws, who);
      else if (m.t === "redeem") await this.redeem(ws, who, m.code);
      else if (m.t === "seen") await this.update(ws, who, m.id, (q) => !q.seenAt && ((q.from === who.login && q.answer) || (q.to === who.login && q.note && !q.answer && !q.dismissed)), (q) => (q.seenAt = Date.now()));
    } catch (e) {
      this.send(ws, { t: "error", why: "Something went wrong on the relay" });
    }
  }

  async webSocketClose(ws) {
    await this.left(ws);
  }

  async webSocketError(ws) {
    await this.left(ws);
  }

  // ===== Who's who ===========================================================================

  async auth(ws, token, invite) {
    let j = null;
    // Local testing only (`wrangler dev --var DEV_AUTH:1`): "dev:<login>" signs in as anyone.
    // Never set DEV_AUTH on the deployed relay.
    if (this.env.DEV_AUTH === "1" && /^dev:[a-z0-9_]+$/.test(token || "")) {
      j = { login: token.slice(4), user_id: token.slice(4), client_id: this.env.TWITCH_CLIENT_ID };
    } else {
      const r = await fetch("https://id.twitch.tv/oauth2/validate", { headers: { Authorization: `OAuth ${token || ""}` } });
      j = r.ok ? await r.json() : null;
    }
    if (!j?.login || j.client_id !== this.env.TWITCH_CLIENT_ID) {
      this.send(ws, { t: "error", why: "signin", detail: "Twitch didn't accept that sign-in" });
      return ws.close(4001, "bad sign-in");
    }
    const allow = await this.allowList();
    const owner = this.owner();
    if (allow && j.login !== owner && !allow.logins.includes(j.login)) {
      await this.askToJoin(j.login, await this.inviter(invite));
      this.send(ws, { t: "error", why: "notallowed", owner, asked: true });
      return ws.close(4003, "not on the allow list");
    }
    const was = this.isOnline(j.login);
    ws.serializeAttachment({ login: j.login, id: j.user_id });
    const user = (await this.ctx.storage.get(`u:${j.login}`)) || { list: [] };
    user.id = j.user_id;
    user.at = Date.now();
    if (!was) user.onlineAt = Date.now(); // came online (first page open)
    await this.ctx.storage.put(`u:${j.login}`, user);
    if (allow && j.login !== owner) await this.linkOwner(j.login, true); // in case it went missing
    await this.sendState(j.login);
    if (!was) await this.tellConnections(j.login);
  }

  // ===== Allow list ==========================================================================

  owner() {
    return String(this.env.OWNER_LOGIN || "").toLowerCase();
  }

  // The allow list, or null when there's no owner (anyone can sign in).
  async allowList() {
    const owner = this.owner();
    if (!owner) return null;
    let a = await this.ctx.storage.get("allow");
    if (!a) {
      // First use: everyone already here stays, connected to the owner.
      const here = Object.keys(await this.users()).filter((l) => l !== owner).sort();
      a = { logins: here, added: Object.fromEntries(here.map((l) => [l, Date.now()])) };
      await this.ctx.storage.put("allow", a);
      for (const l of here) await this.linkOwner(l, true);
    }
    return a;
  }

  // The channels someone mods, as their own panel read them from Twitch. Shared only with
  // their mutual connections (each connection's "modFor" in state).
  async setModFor(login, list) {
    if (!Array.isArray(list)) return;
    const clean = [...new Set(list.map((l) => String(l || "").toLowerCase()).filter((l) => /^[a-z0-9_]{2,25}$/.test(l)))].sort().slice(0, MAX_MOD_FOR);
    const user = (await this.ctx.storage.get(`u:${login}`)) || { list: [] };
    if (JSON.stringify(user.modFor || []) === JSON.stringify(clean)) return;
    user.modFor = clean;
    await this.ctx.storage.put(`u:${login}`, user);
    await this.tellConnections(login);
  }

  limitOf(login, a) {
    return a?.limits?.[login] || TOP_EIGHT;
  }

  // The owner and someone on the list: added to each other's lists (or taken off both).
  async linkOwner(login, on) {
    const owner = this.owner();
    if (!owner || login === owner) return;
    const [uo, ul] = await Promise.all([this.ctx.storage.get(`u:${owner}`), this.ctx.storage.get(`u:${login}`)]);
    const o = uo || { list: [] };
    const u = ul || { list: [] };
    const had = o.list.includes(login) && u.list.includes(owner);
    if (on && had) return;
    o.list = on ? [...new Set([...o.list, login])] : o.list.filter((l) => l !== login);
    u.list = on ? [...new Set([...u.list, owner])] : u.list.filter((l) => l !== owner);
    await this.ctx.storage.put(`u:${owner}`, o);
    await this.ctx.storage.put(`u:${login}`, u);
    await this.tellRoom(owner, [login]);
    await this.tellRoom(login, [owner]);
  }

  // Someone turned away: remembered as asking to join, and the owner's panel hears now.
  // by: who invited them, when they came with an invite link.
  async askToJoin(login, by = "") {
    const a = await this.allowList();
    const was = a.asks?.[login];
    a.asks = { ...a.asks, [login]: { at: Date.now(), first: was?.first || Date.now(), tries: (was?.tries || 0) + 1, ...((by || was?.by) ? { by: by || was.by } : {}) } };
    const all = Object.entries(a.asks).sort((x, y) => y[1].at - x[1].at);
    if (all.length > MAX_ASKS) a.asks = Object.fromEntries(all.slice(0, MAX_ASKS));
    await this.ctx.storage.put("allow", a);
    if (this.isOnline(this.owner())) await this.sendState(this.owner());
  }

  async setAllowed(login, m) {
    const owner = this.owner();
    if (!owner || login !== owner) return;
    const other = String(m.login || "").replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9_]{2,25}$/.test(other) || other === owner) return;
    const a = await this.allowList();
    if (m.dismiss) {
      if (!a.asks?.[other]) return;
      a.asks = { ...a.asks };
      delete a.asks[other];
      await this.ctx.storage.put("allow", a);
      return this.sendState(owner);
    }
    if ("limit" in m) {
      const n = Math.round(Number(m.limit));
      if (!a.logins.includes(other) || !(n >= TOP_EIGHT && n <= MAX_LIMIT)) return;
      a.limits = { ...a.limits };
      if (n === TOP_EIGHT) delete a.limits[other];
      else a.limits[other] = n;
      await this.ctx.storage.put("allow", a);
      await this.sendState(other);
      return this.sendState(owner);
    }
    const on = !!m.on;
    if (on === a.logins.includes(other)) return this.sendState(owner);
    if (on) {
      a.logins = [...a.logins, other].sort();
      a.added = { ...a.added, [other]: Date.now() };
      if (a.asks?.[other]) {
        a.asks = { ...a.asks };
        delete a.asks[other];
      }
    } else {
      a.logins = a.logins.filter((l) => l !== other);
      delete a.added[other];
      if (a.limits) delete a.limits[other];
    }
    await this.ctx.storage.put("allow", a);
    await this.linkOwner(other, on);
    if (!on) {
      // Off the list: signed out now, wherever they are.
      for (const ws of this.sockets(other)) {
        this.send(ws, { t: "error", why: "notallowed", owner });
        ws.close(4003, "not on the allow list");
      }
    }
    await this.sendState(owner);
  }

  async left(ws) {
    const who = ws.deserializeAttachment() || {};
    if (who.login && who.viewer && !this.sockets(who.login, ws).some((w) => w.deserializeAttachment()?.viewer)) {
      await this.ctx.storage.delete(`v:${who.login}`);
      if (this.isOnline(who.login, ws)) await this.tellView(who.login, null);
    }
    if (who.login && !this.isOnline(who.login, ws)) {
      // Their last page closed: remember when, for "last online at".
      const user = await this.ctx.storage.get(`u:${who.login}`);
      if (user) {
        if (user.status !== "offline") user.lastOnline = Date.now();
        await this.ctx.storage.put(`u:${who.login}`, user);
      }
      await this.tellConnections(who.login);
    }
  }

  sockets(login, except) {
    return this.ctx.getWebSockets().filter((w) => w !== except && w.readyState === 1 && w.deserializeAttachment()?.login === login);
  }

  isOnline(login, except) {
    return this.sockets(login, except).length > 0;
  }

  // What connections see: connected, and not set to Offline.
  shownOnline(login, users) {
    return this.isOnline(login) && users[login]?.status !== "offline";
  }

  async setStatus(login, m) {
    if (!["online", "modding", "idle", "offline"].includes(m.status)) return;
    const user = (await this.ctx.storage.get(`u:${login}`)) || { list: [] };
    // Going Offline counts as leaving; coming back from it, as coming online.
    if (m.status === "offline" && user.status !== "offline") user.lastOnline = Date.now();
    if (m.status !== "offline" && user.status === "offline") user.onlineAt = Date.now();
    if (m.status === "modding") delete user.status; // Modding is the default
    else user.status = m.status;
    await this.ctx.storage.put(`u:${login}`, user);
    await this.sendState(login);
    await this.tellConnections(login);
  }

  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }

  sendTo(login, msg) {
    for (const ws of this.sockets(login)) this.send(ws, msg);
  }

  async users() {
    return Object.fromEntries([...(await this.ctx.storage.list({ prefix: "u:" }))].map(([k, v]) => [k.slice(2), v]));
  }

  async mutual(a, b) {
    const [ua, ub] = await Promise.all([this.ctx.storage.get(`u:${a}`), this.ctx.storage.get(`u:${b}`)]);
    return !!(ua?.list.includes(b) && ub?.list.includes(a));
  }

  // Everything one person's pages need: their connections (and who's online
  // among the mutual ones), requests from people who added them, and the
  // week's questions to or from them.
  async sendState(login) {
    if (!this.isOnline(login)) return;
    const users = await this.users();
    const mine = users[login]?.list || [];
    const connections = mine.map((l) => {
      const mutual = !!users[l]?.list.includes(login);
      const online = mutual && this.shownOnline(l, users);
      // since: when they came online (while they are); last: when they were last online.
      const since = online ? users[l]?.onlineAt || 0 : 0;
      const last = mutual && !online ? users[l]?.lastOnline || 0 : 0;
      // modding: online and ready to mod (their sword is lit).
      // modFor: the channels they mod (mutual connections only).
      return { login: l, mutual, online, idle: online && users[l]?.status === "idle", modding: online && !users[l]?.status, since, last, modFor: mutual ? users[l]?.modFor || [] : [] };
    });
    const requests = Object.entries(users).filter(([l, u]) => l !== login && u.list.includes(login) && !mine.includes(l)).map(([l]) => l);
    const questions = [];
    for (const [k, q] of await this.ctx.storage.list({ prefix: "q:" })) {
      if (Date.now() - q.at > WEEK_MS) await this.ctx.storage.delete(k);
      else if (q.from === login || q.to === login) questions.push(q);
    }
    const pins = [];
    for (const [k, f] of await this.ctx.storage.list({ prefix: "p:" })) {
      if (Date.now() - f.at > PIN_MS) await this.ctx.storage.delete(k);
      else if (pinTargets(f, users).includes(login)) pins.push(f);
    }
    const rooms = this.roomsFor(login, users);
    const chat = {};
    for (const r of rooms) chat[r.owner] = await this.recentChat(r.owner);
    const stats = {};
    for (const l of [login, ...connections.filter((c) => c.mutual && users[c.login]?.statsOn).map((c) => c.login)]) {
      const rec = await this.ctx.storage.get(`s:${l}`);
      if (rec) stats[l] = workOut(rec);
    }
    const views = {};
    for (const c of connections) {
      if (!c.online || users[c.login]?.status === "offline" || !this.viewing(c.login)) continue;
      const v = await this.ctx.storage.get(`v:${c.login}`);
      if (v) views[c.login] = v;
    }
    const owner = this.owner() || null;
    let allowed, asking;
    if (owner && login === owner) {
      const a = await this.allowList();
      // joined: they've signed in at least once.
      // used: how many people they've added (not counting the owner), of limit.
      allowed = a.logins.map((l) => ({ login: l, added: a.added?.[l] || 0, joined: !!users[l]?.at, used: (users[l]?.list || []).filter((x) => x !== owner).length, limit: this.limitOf(l, a) }));
      asking = Object.entries(a.asks || {}).map(([l, x]) => ({ login: l, at: x.at, first: x.first, tries: x.tries, by: x.by || "" })).sort((x, y) => y.at - x.at);
    }
    const limit = owner && login !== owner ? this.limitOf(login, await this.allowList()) : null;
    this.sendTo(login, { t: "state", me: login, owner, allowed, asking, limit, status: users[login]?.status || "modding", since: users[login]?.onlineAt || 0, connections, requests, tags: users[login]?.tags || {}, questions, pins, rooms, chat, statsOn: !!users[login]?.statsOn, stats, views });
  }

  // A room's latest messages. Anything over a week old is deleted, even if nobody
  // has posted there since.
  async recentChat(owner) {
    const msgs = [...(await this.ctx.storage.list({ prefix: `m:${owner}:`, reverse: true, limit: CHAT_BACKLOG }))];
    const old = msgs.filter(([, v]) => Date.now() - v.at > WEEK_MS).map(([k]) => k);
    if (old.length) await this.ctx.storage.delete(old);
    return msgs.filter(([k]) => !old.includes(k)).map(([, v]) => v).reverse();
  }

  // Who's in an owner's room: them, plus their mutual connections in the
  // room's tag. A private chat is just its two people, while they're mutual.
  members(owner, users) {
    if (owner.startsWith("@")) {
      const [a, b] = owner.slice(1).split("+");
      return users[a]?.list.includes(b) && users[b]?.list.includes(a) ? [a, b] : [];
    }
    const o = users[owner];
    if (!o?.room?.tag) return [];
    const tagged = (o.tags?.[o.room.tag] || []).filter((l) => o.list.includes(l) && users[l]?.list.includes(owner));
    return [owner, ...tagged];
  }

  roomsFor(login, users) {
    const online = (members) => members.map((l) => ({ login: l, online: this.shownOnline(l, users) }));
    const groups = Object.keys(users)
      .map((owner) => ({ owner, tag: users[owner].room?.tag, members: this.members(owner, users) }))
      .filter((r) => r.members.includes(login))
      .map((r) => ({ ...r, members: online(r.members) }));
    const direct = (users[login]?.list || [])
      .filter((l) => users[l]?.list.includes(login))
      .map((l) => {
        const owner = `@${[login, l].sort().join("+")}`;
        return { owner, direct: true, with: l, members: online(this.members(owner, users)) };
      });
    return [...groups, ...direct];
  }

  // A room's members changed (or might have): everyone in it before or after hears.
  async tellRoom(owner, extra = []) {
    const users = await this.users();
    for (const l of new Set([...this.members(owner, users), ...extra, owner])) await this.sendState(l);
  }

  // Someone came online or went away: their mutual connections' pages hear.
  // So do the people in any room they're in (who may not be connected to them).
  async tellConnections(login) {
    const users = await this.users();
    const told = new Set();
    for (const [l, u] of Object.entries(users)) {
      if (u.list.includes(login) && users[login]?.list.includes(l)) told.add(l);
    }
    for (const r of this.roomsFor(login, users)) for (const m of r.members) if (m.login !== login) told.add(m.login);
    for (const l of told) await this.sendState(l);
  }

  // ===== Streamer View =======================================================================

  // Is one of their OBS docks connected and sharing what it shows?
  viewing(login) {
    return this.sockets(login).some((w) => w.deserializeAttachment()?.viewer);
  }

  async setView(ws, who, raw) {
    // null: the streamer switched sharing off in Settings.
    if (raw === null) {
      if (!who.viewer) return;
      ws.serializeAttachment({ ...who, viewer: false });
      if (this.viewing(who.login)) return; // another of their docks still shares
      await this.ctx.storage.delete(`v:${who.login}`);
      return this.tellView(who.login, null);
    }
    const v = cleanView(raw);
    if (!v) return;
    if (!who.viewer) ws.serializeAttachment({ ...who, viewer: true });
    await this.ctx.storage.put(`v:${who.login}`, v);
    await this.tellView(who.login, v);
  }

  // Their mutual connections who are online hear (nothing while they're set to Offline).
  async tellView(login, v) {
    const users = await this.users();
    if (users[login]?.status === "offline") v = null;
    for (const l of users[login]?.list || []) {
      if (users[l]?.list.includes(login)) this.sendTo(l, { t: "view", owner: login, v });
    }
  }

  // ===== Invite links ========================================================================

  async makeInvite(ws, who) {
    const user = (await this.ctx.storage.get(`u:${who.login}`)) || { list: [] };
    const now = Date.now();
    const keep = []; // links still within their week (used or not)
    let open = 0;
    for (const code of user.invites || []) {
      const inv = await this.ctx.storage.get(`inv:${code}`);
      if (inv && now - inv.at < INVITE_MS) {
        keep.push(code);
        if (!inv.used) open++;
      } else await this.ctx.storage.delete(`inv:${code}`);
    }
    if (open >= MAX_OPEN_INVITES) return this.send(ws, { t: "error", why: `You have ${MAX_OPEN_INVITES} invite links nobody has used yet. Each one runs out after a week` });
    let code = inviteCode();
    while (await this.ctx.storage.get(`inv:${code}`)) code = inviteCode();
    await this.ctx.storage.put(`inv:${code}`, { from: who.login, at: now, used: null });
    user.invites = [...keep, code];
    await this.ctx.storage.put(`u:${who.login}`, user);
    this.send(ws, { t: "invite", code, expires: now + INVITE_MS });
  }

  // Who made an invite link, while it can still be used ("" if it can't).
  async inviter(code) {
    code = String(code || "").toLowerCase();
    if (!INVITE_RE.test(code)) return "";
    const inv = await this.ctx.storage.get(`inv:${code}`);
    return inv && !inv.used && Date.now() - inv.at < INVITE_MS ? inv.from : "";
  }

  async redeem(ws, who, code) {
    const fail = (detail) => this.send(ws, { t: "error", why: "invite", detail });
    code = String(code || "").toLowerCase();
    const inv = INVITE_RE.test(code) ? await this.ctx.storage.get(`inv:${code}`) : null;
    if (!inv || Date.now() - inv.at >= INVITE_MS) return fail("That invite link has run out, or isn't quite right. Ask for a new one.");
    if (inv.used) return inv.used.by === who.login ? this.send(ws, { t: "redeemed", from: inv.from }) : fail("That invite link has already been used. Ask for a new one.");
    if (inv.from === who.login) return fail("That's your own invite link. Send it to the person you want to connect with.");
    // Top 8, on both sides, before anything changes.
    const owner = this.owner();
    const a = await this.allowList();
    const [me, them] = await Promise.all([this.ctx.storage.get(`u:${who.login}`), this.ctx.storage.get(`u:${inv.from}`)]);
    const full = (login, u, other) => !!owner && login !== owner && !(u?.list || []).includes(other) && (u?.list || []).filter((l) => l !== owner).length >= this.limitOf(login, a);
    if (full(who.login, me, inv.from)) return this.send(ws, { t: "error", why: "topeight", limit: this.limitOf(who.login, a), owner });
    if (full(inv.from, them, who.login)) return fail(`${inv.from}'s list is full, so they can't add anyone else right now.`);
    inv.used = { by: who.login, at: Date.now() };
    await this.ctx.storage.put(`inv:${code}`, inv);
    await this.setConnection(who.login, inv.from, true);
    await this.setConnection(inv.from, who.login, true);
    this.send(ws, { t: "redeemed", from: inv.from });
    this.sendTo(inv.from, { t: "invited", login: who.login });
  }

  async setConnection(login, other, on) {
    other = String(other || "").toLowerCase();
    if (!/^[a-z0-9_]{2,25}$/.test(other) || other === login) return;
    // The owner is everyone's first connection: only the allow list can end it.
    const owner = this.owner();
    if (!on && owner && (login === owner || other === owner) && (await this.allowList()).logins.includes(login === owner ? other : login)) {
      return this.sendTo(login, { t: "error", why: login === owner ? "Take them off the allow list to remove them" : `${owner} is everyone's first connection` });
    }
    const user = (await this.ctx.storage.get(`u:${login}`)) || { list: [] };
    if (on && owner && login !== owner && !user.list.includes(other)) {
      const limit = this.limitOf(login, await this.allowList());
      if (user.list.filter((l) => l !== owner).length >= limit) return this.sendTo(login, { t: "error", why: "topeight", limit, owner });
    }
    user.list = on ? [...new Set([...user.list, other])] : user.list.filter((l) => l !== other);
    await this.ctx.storage.put(`u:${login}`, user);
    await this.tellRoom(login, [other]);
    await this.tellRoom(other, [login]);
  }

  async setTag(login, m) {
    const tag = clean(m.tag).slice(0, MAX_TAG_LEN);
    const other = String(m.login || "").toLowerCase();
    if (!tag || !/^[a-z0-9_]{2,25}$/.test(other)) return;
    const user = (await this.ctx.storage.get(`u:${login}`)) || { list: [] };
    const tags = user.tags || {};
    if (!tags[tag] && Object.keys(tags).length >= MAX_TAGS) return;
    const members = new Set(tags[tag] || []);
    m.on ? members.add(other) : members.delete(other);
    if (members.size) tags[tag] = [...members];
    else delete tags[tag];
    const before = this.members(login, await this.users());
    user.tags = tags;
    await this.ctx.storage.put(`u:${login}`, user);
    if (user.room?.tag === tag) await this.tellRoom(login, [...before, other]);
    else await this.sendState(login);
  }

  async setRoom(login, m) {
    const user = (await this.ctx.storage.get(`u:${login}`)) || { list: [] };
    const before = this.members(login, await this.users());
    const tag = m.tag ? clean(m.tag).slice(0, MAX_TAG_LEN) : "";
    user.room = tag && user.tags?.[tag] ? { tag } : null;
    await this.ctx.storage.put(`u:${login}`, user);
    await this.tellRoom(login, before);
  }

  async say(ws, who, m) {
    const owner = String(m.owner || "").toLowerCase();
    const text = String(m.text || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_SAY_LEN);
    if (!text) return;
    const users = await this.users();
    const members = this.members(owner, users);
    if (!members.includes(who.login)) return this.send(ws, { t: "error", why: "You're not in that room" });
    this.saidAt ||= {};
    const recent = (this.saidAt[who.login] || []).filter((t) => Date.now() - t < 60000);
    if (recent.length >= MAX_SAYS_PER_MINUTE) return this.send(ws, { t: "error", why: "Slow down a little" });
    this.saidAt[who.login] = [...recent, Date.now()];
    const at = Date.now();
    const msg = { id: `${at.toString(36)}${crypto.randomUUID().slice(0, 4)}`, owner, from: who.login, text, at };
    await this.ctx.storage.put(`m:${owner}:${String(at).padStart(15, "0")}:${msg.id}`, msg);
    for (const l of members) this.sendTo(l, { t: "msg", m: msg });
    // A week is plenty: drop older messages in this room.
    const old = [...(await this.ctx.storage.list({ prefix: `m:${owner}:`, limit: 50 }))].filter(([, v]) => at - v.at > WEEK_MS).map(([k]) => k);
    if (old.length) await this.ctx.storage.delete(old);
  }

  // ===== Stats ===============================================================================

  async statsShare(login, m) {
    const user = (await this.ctx.storage.get(`u:${login}`)) || { list: [] };
    user.statsOn = !!m.on;
    await this.ctx.storage.put(`u:${login}`, user);
    await this.sendState(login);
    await this.tellConnections(login);
  }

  // Tell the owner, and their mutual connections if they share.
  async shareStats(login, rec) {
    const users = await this.users();
    const s = workOut(rec);
    this.sendTo(login, { t: "stats", owner: login, s });
    if (!users[login]?.statsOn) return;
    for (const l of users[login].list) {
      if (users[l]?.list.includes(login)) this.sendTo(l, { t: "stats", owner: login, s });
    }
  }

  async sample(login, raw) {
    if (!raw || typeof raw !== "object") return;
    const rec = (await this.ctx.storage.get(`s:${login}`)) || { days: {}, months: {} };
    const startedAt = short(raw.startedAt, 40);
    const viewers = count(raw.viewers);
    const live = !!raw.live;
    rec.now = {
      live, viewers, startedAt, game: short(raw.game, 80), title: short(raw.title, 140),
      followers: count(raw.followers), subsTotal: raw.subsTotal == null ? null : count(raw.subsTotal),
      adNext: short(raw.adNext, 40), chatMode: short(raw.chatMode, 60), nextStream: short(raw.nextStream, 120),
      clip: raw.clip && { title: short(raw.clip.title, 100), url: /^https:\/\/[a-z.]*twitch\.tv\//.test(raw.clip.url || "") ? raw.clip.url : "", at: short(raw.clip.at, 40) },
      at: Date.now(),
    };
    if (live) {
      if (rec.stream?.startedAt !== startedAt) rec.stream = { startedAt, subs: 0, gifts: 0, gifters: {}, bits: 0, follows: 0, peak: 0, sum: 0, n: 0 };
      rec.stream.peak = Math.max(rec.stream.peak, viewers);
      rec.stream.sum += viewers;
      rec.stream.n++;
      const day = /^\d{4}-\d{2}-\d{2}$/.test(raw.day || "") ? raw.day : new Date().toISOString().slice(0, 10);
      const d = (rec.days[day] ||= { peak: 0, sum: 0, n: 0 });
      d.peak = Math.max(d.peak, viewers);
      d.sum += viewers;
      d.n++;
      for (const k of Object.keys(rec.days).sort().slice(0, -STAT_DAYS_KEPT)) delete rec.days[k];
    }
    await this.ctx.storage.put(`s:${login}`, rec);
    await this.shareStats(login, rec);
  }

  async statEvent(login, m) {
    const rec = (await this.ctx.storage.get(`s:${login}`)) || { days: {}, months: {} };
    const n = count(m.n) || 1;
    const who = short(m.who, 30);
    const stream = rec.now?.live ? rec.stream : null;
    const month = new Date().toISOString().slice(0, 7);
    const addSubs = () => {
      if (stream) stream.subs += n;
      rec.months[month] = (rec.months[month] || 0) + n;
      for (const k of Object.keys(rec.months).sort().slice(0, -13)) delete rec.months[k];
    };
    if (m.kind === "sub") addSubs();
    else if (m.kind === "gift") {
      addSubs();
      if (stream) {
        stream.gifts += n;
        if (who) stream.gifters[who] = (stream.gifters[who] || 0) + n;
      }
    } else if (m.kind === "bits" && stream) stream.bits += n;
    else if (m.kind === "follow" && stream) stream.follows += 1;
    else if (m.kind === "raidOut") rec.lastRaidOut = { who, viewers: count(m.viewers), at: Date.now() };
    else if (m.kind === "raidIn") rec.lastRaidIn = { who, viewers: count(m.viewers), at: Date.now() };
    else if (m.kind === "hype") rec.hype = m.hype && { level: count(m.hype.level), progress: count(m.hype.progress), goal: count(m.hype.goal), ends: short(m.hype.ends, 40) };
    else return;
    await this.ctx.storage.put(`s:${login}`, rec);
    await this.shareStats(login, rec);
  }

  // ===== Flashes =============================================================================

  async flash(ws, who, m) {
    const kind = m.kind;
    if (!["info", "love", "chat"].includes(kind)) return;
    const text = kind === "chat" ? cleanTo(m.text, MAX_FLAGGED_LEN) : clean(m.text).slice(0, kind === "love" ? MAX_LOVE_LEN : MAX_LEN);
    if (!text) return;
    this.flashedAt ||= {};
    const recent = (this.flashedAt[who.login] || []).filter((t) => Date.now() - t < 60000);
    if (recent.length >= MAX_FLASHES_PER_MINUTE) return this.send(ws, { t: "error", why: "Slow down a little" });
    this.flashedAt[who.login] = [...recent, Date.now()];

    const users = await this.users();
    const mine = users[who.login] || { list: [] };
    const mutual = (l) => mine.list.includes(l) && users[l]?.list.includes(who.login);
    const f = { id: crypto.randomUUID().slice(0, 8), kind, from: who.login, text, at: Date.now() };
    if (/^#[0-9a-f]{6}$/i.test(m.color || "")) f.color = m.color;

    let targets;
    if (kind === "chat") {
      const channel = String(m.channel || "").toLowerCase();
      if (channel !== who.login && !mutual(channel)) return this.send(ws, { t: "error", why: `You and ${channel} need to add each other first` });
      Object.assign(f, { channel, to: channel, chatter: clean(m.chatter).slice(0, 25), chatterName: clean(m.chatterName).slice(0, 50), emotes: cleanEmotes(m.emotes) });
      if (/^#[0-9a-f]{6}$/i.test(m.chatterColor || "")) f.chatterColor = m.chatterColor;
      // Pinned for five minutes, so it's still there after a reload.
      await this.ctx.storage.put(`p:${f.id}`, f);
      for (const l of pinTargets(f, users)) this.sendTo(l, { t: "flash", f });
      return this.send(ws, { t: "flashed", kind, reached: this.isOnline(channel) ? 1 : 0, to: channel });
    }

    if (m.to === "*") targets = mine.list.filter(mutual);
    else if (String(m.to || "").startsWith("#")) targets = (mine.tags?.[String(m.to).slice(1)] || []).filter(mutual);
    else {
      const to = String(m.to || "").toLowerCase();
      if (!mutual(to)) return this.send(ws, { t: "error", why: `You and ${to} need to add each other first` });
      targets = [to];
    }
    const online = targets.filter((l) => this.isOnline(l));
    for (const l of online) this.sendTo(l, { t: "flash", f: { ...f, to: l } });
    // Kept for a few minutes (while it can still be showing), so its sender can take it
    // back. In storage, as the hub sleeps between messages and forgets anything in memory.
    const old = await this.ctx.storage.list({ prefix: "f:" });
    const stale = [...old].filter(([, r]) => Date.now() - r.at > SENT_FLASH_MS).map(([k]) => k);
    if (stale.length) await this.ctx.storage.delete(stale);
    if (online.length) await this.ctx.storage.put(`f:${f.id}`, { from: who.login, to: online, at: f.at });
    this.send(ws, { t: "flashed", kind, reached: online.length });
  }

  // Clearing a pin clears it for everyone who has it; any of them can.
  async unflash(who, m) {
    const key = `p:${String(m.id || "").slice(0, 8)}`;
    const f = await this.ctx.storage.get(key);
    if (!f) {
      // A quick note or !vanish: only its sender can take it back.
      const sentKey = `f:${String(m.id || "").slice(0, 8)}`;
      const r = await this.ctx.storage.get(sentKey);
      if (!r || r.from !== who.login) return;
      await this.ctx.storage.delete(sentKey);
      for (const l of r.to) this.sendTo(l, { t: "unflash", id: String(m.id) });
      return;
    }
    const targets = pinTargets(f, await this.users());
    if (!targets.includes(who.login)) return;
    await this.ctx.storage.delete(key);
    for (const l of targets) this.sendTo(l, { t: "unflash", id: f.id });
  }

  // ===== Chat notes ==========================================================================
  // A note on one line of a channel's chat, written while it's live or on a VOD comment.
  // Kept against that moment, so it comes back on the same line in the VOD's chat replay.
  // No list or archive: a VOD asks only for the notes between its start and end.
  // Any channel's chat, not just connected streamers'. Seen by whoever wrote it and their
  // mutual connections; and when the writer is the channel or one of its mutual
  // connections, by the channel's owner and their mutual connections too (noteSeers).
  // Kept as "n:<channel>:<at>:<id>" and dropped after NOTE_MS.

  async note(ws, who, m) {
    const channel = String(m.channel || "").toLowerCase();
    const body = cleanTo(m.body, MAX_NOTE_LEN);
    const text = cleanTo(m.text, MAX_FLAGGED_LEN);
    const chatter = clean(m.chatter).slice(0, 25).toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(channel) || !body || !text || !chatter) return;
    this.notedAt ||= {};
    const recent = (this.notedAt[who.login] || []).filter((t) => Date.now() - t < 60000);
    if (recent.length >= MAX_NOTES_PER_MINUTE) return this.send(ws, { t: "error", why: "Slow down a little" });
    this.notedAt[who.login] = [...recent, Date.now()];

    const users = await this.users();
    // A note left on a VOD comment says when that comment was (any time in the last NOTE_MS);
    // a live one is now.
    const now = Date.now();
    const asked = Math.floor(Number(m.at) || 0);
    const at = asked > now - NOTE_MS && asked <= now ? asked : now;
    const n = { id: crypto.randomUUID().slice(0, 8), channel, chatter, chatterName: clean(m.chatterName).slice(0, 50), text, from: who.login, body, at };
    if (/^#[0-9a-f]{6}$/i.test(m.color || "")) n.color = m.color;
    await this.ctx.storage.put(noteKey(n), n);
    // This channel's notes from before NOTE_MS go now.
    const old = await this.ctx.storage.list({ prefix: `n:${channel}:`, end: `n:${channel}:${pad13(now - NOTE_MS)}` });
    if (old.size) await this.ctx.storage.delete([...old.keys()]);
    for (const l of noteSeers(n, users)) this.sendTo(l, { t: "note", n });
  }

  // A channel's notes from one moment to another (ms): a VOD's, or a live channel's
  // last few hours. Only the ones this person can see.
  async notes(ws, who, m) {
    const channel = String(m.channel || "").toLowerCase();
    const from = Number(m.from) || 0;
    const to = Math.min(Number(m.to) || 0, Date.now());
    if (!/^[a-z0-9_]{1,25}$/.test(channel) || !from || to <= from) return;
    const users = await this.users();
    const found = await this.ctx.storage.list({ start: `n:${channel}:${pad13(from)}`, end: `n:${channel}:${pad13(to + 1)}`, limit: MAX_NOTES_SENT });
    this.send(ws, { t: "notes", channel, from, to, list: [...found.values()].filter((n) => Date.now() - n.at < NOTE_MS && noteSeers(n, users).includes(who.login)) });
  }

  // Only whoever wrote a note can take it back.
  async unnote(who, m) {
    const key = noteKey({ channel: String(m.channel || "").toLowerCase(), at: Number(m.at) || 0, id: String(m.id || "").slice(0, 8) });
    const n = await this.ctx.storage.get(key);
    if (!n || n.from !== who.login) return;
    await this.ctx.storage.delete(key);
    for (const l of noteSeers(n, await this.users())) this.sendTo(l, { t: "unnote", id: n.id });
  }

  // ===== Questions ===========================================================================

  // To one person, or to "*": everyone you're mutually connected with, as one
  // copy each sharing a group id (each answers on their own copy).
  async ask(ws, who, m) {
    const text = clean(m.text);
    if (!text) return;
    const tagName = String(m.to || "").startsWith("#") ? String(m.to).slice(1) : null;
    const everyone = m.to === "*" || tagName !== null;
    let targets;
    if (everyone) {
      const users = await this.users();
      const mine = users[who.login] || { list: [] };
      const pool = tagName !== null ? mine.tags?.[tagName] || [] : mine.list;
      targets = pool.filter((l) => mine.list.includes(l) && users[l]?.list.includes(who.login));
      if (!targets.length) return this.send(ws, { t: "error", why: tagName !== null ? `Nobody in ${tagName} can be asked yet` : "Nobody to ask yet: add people under Connections" });
      // "online": only those online right now (shown as online or idle); nothing waits for
      // anyone else. The streamer's "Online mods".
      if (m.online) {
        targets = targets.filter((l) => this.shownOnline(l, users));
        if (!targets.length) return this.send(ws, { t: "error", why: tagName !== null ? `Nobody in ${tagName} is online right now` : "Nobody's online right now" });
      }
    } else {
      const to = String(m.to || "").toLowerCase();
      if (!(await this.mutual(who.login, to))) return this.send(ws, { t: "error", why: `You and ${to} need to add each other first` });
      targets = [to];
    }
    const all = [...(await this.ctx.storage.list({ prefix: "q:" })).values()];
    const recent = new Set(all.filter((q) => q.from === who.login && Date.now() - q.at < 60000).map((q) => q.group || q.id));
    if (recent.size >= MAX_ASKS_PER_MINUTE) {
      return this.send(ws, { t: "error", why: "That's a lot of questions at once; try again in a minute" });
    }
    const open = (to) => all.filter((q) => q.from === who.login && q.to === to && !q.note && !q.answer && !q.dismissed).length;
    const note = !!m.note;
    const full = note ? [] : targets.filter((to) => open(to) >= MAX_OPEN_PER_PAIR);
    if (!everyone && full.length) {
      return this.send(ws, { t: "error", why: `${full[0]} already has ${MAX_OPEN_PER_PAIR} unanswered questions from you` });
    }
    const group = everyone ? crypto.randomUUID().slice(0, 8) : null;
    const options = note ? [] : cleanOptions(m.options);
    let sent = 0;
    for (const to of targets) {
      if (full.includes(to)) continue; // asking everyone skips anyone already full up
      const q = { id: crypto.randomUUID().slice(0, 8), from: who.login, to, text, at: Date.now(), options, answer: null, dismissed: 0, seenAt: 0 };
      if (group) Object.assign(q, { group, toTag: tagName ?? "everyone" });
      if (note) q.note = true;
      await this.ctx.storage.put(`q:${q.id}`, q);
      this.share(q);
      sent++;
    }
    if (!sent) this.send(ws, { t: "error", why: `Everyone already has ${MAX_OPEN_PER_PAIR} unanswered questions from you` });
  }

  // Only with one of the question's own options, or a typed reply.
  async answer(ws, who, m) {
    const code = String(m.code || "");
    const text = code === "c" || code === "x" ? clean(m.text) : "";
    const offered = (q) => {
      const options = q.options || STANDARD;
      if (code === "c") return !!text;
      if (ALWAYS_ANSWERS.includes(code)) return true; // heart, yes, no, maybe: the streamer's four
      if (code === "x") return options.includes(`+${text}`);
      return STANDARD.includes(code) && options.includes(code);
    };
    await this.update(ws, who, m.id, (q) => q.to === who.login && !q.answer && !q.dismissed && offered(q), (q) => (q.answer = { code, text, at: Date.now() }));
  }

  // Nudge: the asker reminds them of a question that's still unanswered. Each nudge moves it
  // up a colour on their screen (orange, yellow, white), up to three, at most one every
  // NUDGE_GAP_MS.
  // warn: the asker tapped Nudge over and over (dock.js): it goes red on their screen with
  // a louder beep, past the wait and the three-nudge limit, at most once every WARN_GAP_MS.
  async nudge(ws, who, id, warn = false) {
    const q = await this.ctx.storage.get(`q:${String(id || "")}`);
    if (!q || q.from !== who.login || q.note || q.answer || q.dismissed) return this.send(ws, { t: "error", why: "That question can't be nudged now" });
    if (warn) {
      if (Date.now() - (q.warnedAt || 0) < WARN_GAP_MS) return this.send(ws, { t: "error", why: "A warning was just sent; give them a moment" });
      q.warnedAt = q.nudgedAt = Date.now();
      q.warns = (q.warns || 0) + 1;
      await this.ctx.storage.put(`q:${q.id}`, q);
      return this.share(q);
    }
    if ((q.nudges || 0) >= MAX_NUDGES) return this.send(ws, { t: "error", why: "Already nudged as far as it goes" });
    if (Date.now() - (q.nudgedAt || 0) < NUDGE_GAP_MS) return this.send(ws, { t: "error", why: "Give them a moment before nudging again" });
    q.nudges = (q.nudges || 0) + 1;
    q.nudgedAt = Date.now();
    await this.ctx.storage.put(`q:${q.id}`, q);
    this.share(q);
  }

  // Change a question if this person's allowed to; both sides hear.
  async update(ws, who, id, allowed, change) {
    const q = await this.ctx.storage.get(`q:${String(id || "")}`);
    if (!q || !allowed(q)) return this.send(ws, { t: "error", why: "That question can't be changed now" });
    change(q);
    await this.ctx.storage.put(`q:${q.id}`, q);
    this.share(q);
  }

  share(q) {
    this.sendTo(q.from, { t: "q", q });
    this.sendTo(q.to, { t: "q", q });
  }
}

const count = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.floor(Number(x)) : 0);
const short = (x, n) => (typeof x === "string" ? clean(x).slice(0, n) : "");

// What people see: the latest numbers, plus averages and highs over time.
function workOut(rec) {
  const now = Date.now();
  const days = Object.entries(rec.days || {});
  const within = (ms) => days.filter(([k]) => now - Date.parse(k) <= ms).map(([, d]) => d);
  const sum = (list) => {
    const n = list.reduce((a, d) => a + d.n, 0);
    return { peak: Math.max(0, ...list.map((d) => d.peak)), avg: n ? Math.round(list.reduce((a, d) => a + d.sum, 0) / n) : 0 };
  };
  const monthKey = new Date(now).toISOString().slice(0, 7);
  const stream = rec.stream;
  const top = stream && Object.entries(stream.gifters || {}).sort((a, b) => b[1] - a[1])[0];
  return {
    now: rec.now || null,
    stream: stream && rec.now?.live ? {
      subs: stream.subs, gifts: stream.gifts, topGifter: top ? { who: top[0], n: top[1] } : null,
      bits: stream.bits, follows: stream.follows, peak: stream.peak, avg: stream.n ? Math.round(stream.sum / stream.n) : 0,
    } : null,
    week: sum(within(7 * 86400000)),
    month: { ...sum(days.filter(([k]) => k.startsWith(monthKey)).map(([, d]) => d)), subs: rec.months?.[monthKey] || 0 },
    lastRaidOut: rec.lastRaidOut || null,
    lastRaidIn: rec.lastRaidIn || null,
    hype: rec.hype || null,
  };
}

// The asker's answer buttons: standard letters and "+label"s, no repeats.
function cleanOptions(list) {
  if (!Array.isArray(list)) return STANDARD;
  const out = [];
  for (const o of list) {
    const v = STANDARD.includes(o) ? o : String(o).startsWith("+") ? `+${clean(String(o).slice(1)).slice(0, MAX_OPTION_LEN)}` : "";
    if (v && v !== "+" && !out.includes(v)) out.push(v);
  }
  return out.slice(0, MAX_OPTIONS);
}

// Chat notes: kept in time order within each channel, so a VOD can ask for a stretch.
const pad13 = (ms) => String(Math.max(0, Math.floor(ms))).padStart(13, "0");
const noteKey = (n) => `n:${n.channel}:${pad13(n.at)}:${n.id}`;

// Who sees a chat note: whoever wrote it and their mutual connections; and when the writer
// is the channel or one of its mutual connections, the channel and its mutual connections.
function noteSeers(n, users) {
  const mutuals = (login) => (users[login]?.list || []).filter((l) => users[l]?.list.includes(login));
  const seers = [n.from, ...mutuals(n.from)];
  const channelCircle = [n.channel, ...mutuals(n.channel)];
  if (channelCircle.includes(n.from)) seers.push(...channelCircle);
  return [...new Set(seers)];
}

function cleanTo(s, max) {
  return String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function clean(s) {
  return cleanTo(s, MAX_LEN);
}

// Who has a flagged line: the channel's owner, their mutual connections, and
// whoever flagged it.
function pinTargets(f, users) {
  const owner = users[f.to] || { list: [] };
  return [...new Set([f.to, f.from, ...owner.list.filter((l) => users[l]?.list.includes(f.to))])];
}

// A flagged line's emotes, { name: picture }, only from the emote sites.
function cleanEmotes(emotes) {
  const out = {};
  for (const [name, url] of Object.entries(emotes && typeof emotes === "object" ? emotes : {}).slice(0, MAX_PIN_EMOTES)) {
    try {
      const u = new URL(String(url));
      if (u.protocol === "https:" && EMOTE_HOSTS.includes(u.hostname) && name.length <= 50) out[name] = u.href;
    } catch {}
  }
  return out;
}

// A Streamer View summary, kept to what the side panel draws.
function cleanView(raw) {
  if (!raw || typeof raw !== "object") return null;
  const str = (x, n = MAX_LEN) => String(x ?? "").slice(0, n);
  const login = (x) => str(x, 25).toLowerCase().replace(/[^a-z0-9_]/g, "");
  const num = (x) => (Number.isFinite(x) ? x : 0);
  const stage = (x) => (Number.isInteger(x) && x >= 0 && x <= 5 ? x : 0); // 5: a warning
  const color = (x) => (/^#[0-9a-f]{6}$/i.test(x || "") ? x : "");
  const list = (x) => (Array.isArray(x) ? x.slice(0, MAX_VIEW_ITEMS) : []);
  return {
    glow: stage(raw.glow),
    chat: raw.chat === "livechat" ? "livechat" : "dock",
    dnd: num(raw.dnd), // Do Not Disturb until then (0: off)
    leads: list(raw.leads).map(login).filter(Boolean), // who chats with Twitch's lead moderator badge
    waiting: list(raw.waiting).map((q) => ({
      id: str(q.id, 60), from: login(q.from), text: str(q.text), at: num(q.at), note: !!q.note, stage: stage(q.stage), nudges: stage(q.nudges),
      options: list(q.options).map((o) => str(o, MAX_OPTION_LEN)),
    })),
    answers: list(raw.answers).map((a) => ({
      id: str(a.id, 60), to: login(a.to), text: str(a.text), said: str(a.said), code: /^[ynmsotcx]$/.test(a.code) ? a.code : "c", at: num(a.at),
    })),
    notes: list(raw.notes).map((f) => ({
      id: str(f.id, 60), kind: ["info", "love", "chat", "seen"].includes(f.kind) ? f.kind : "info", from: login(f.from), text: str(f.text, MAX_FLAGGED_LEN),
      chatter: str(f.chatter, 25), chatterColor: color(f.chatterColor), color: color(f.color), at: num(f.at),
    })),
  };
}

// Streamer Buddy System relay: a Cloudflare Worker with one Durable Object,
// the hub, that every Streamer Buddy System page (the streamer's OBS dock and
// the hub in Twitch Space's side panel) keeps a WebSocket open to.
//
// Signing in: a page's first message is { t: "auth", token } with its Twitch
// sign-in. The hub asks Twitch who that is (id.twitch.tv/oauth2/validate) and
// only accepts sign-ins made for our own Twitch app, so who sent something
// always comes from Twitch, never from the message.
//
// Connections: each person's list of who they've added. Two people can ask
// each other only once both have added each other ("mutual"); until then the
// other side sees the request. Whether someone's online is only shared
// between mutual connections.
//
// Questions: { id, from, to, text, at, options, answer: { code, text, at } | null,
// dismissed, seenAt, group }. Asking everyone ("to": "*") makes one copy per
// mutual connection, sharing a group id; asking a tag ("#Mods") does the same
// for the people in it. toTag says who it went to ("everyone", or the tag).
//
// Rooms: each person (usually a streamer) can have one chat room, open to one
// of their tags (e.g. Mods): they and the mutual connections in that tag can
// talk there. Messages are kept a week (the last 50 come with the state).
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
// Messages from a page:
//   auth { token }          connect { login }        disconnect { login }
//   ask { to, text, options }  answer { id, code, text }  dismiss { id }
//   tag { login, tag, on }  put a connection in (or out of) one of your tags
//   room { tag }            open your chat room to one of your tags (null closes it)
//   say { owner, text }     post in someone's room (yours: owner is you)
//   flash { kind, to, text, chatter, color, channel }  something quick that
//                           shows for a moment; see Flashes below
//   statsShare { on }       share your stream stats with your connections
//   sample { s }            your panel's latest numbers; see Stats below
//   statEvent { kind, n, who, viewers }  a sub, gift, cheer, follow or raid
//   seen { id }
// Messages to a page:
//   state { me, connections, requests, tags, questions, rooms, chat, statsOn, stats }   (on sign-in, and whenever
//                                                       connections or who's online change)
//   q { q }                 a question that's new or changed
//   msg { m }               a new chat message { id, owner, from, text, at }
//   flash { f }             a flash { id, kind, from, to, text, chatter, color, channel, at }
//   flashed { kind, reached }  how many people yours reached
//   stats { owner, s }      someone's worked-out stats changed
//   error { why }
// A plain "ping" gets "pong" without waking the hub (keeps idle pages cheap).

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LEN = 200;
const MAX_OPEN_PER_PAIR = 3;
const MAX_ASKS_PER_MINUTE = 10;
const STANDARD = ["y", "n", "m", "s", "o", "t"];
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      return env.HUB.get(env.HUB.idFromName("hub")).fetch(req);
    }
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
    if (m.t === "auth") return this.auth(ws, m.token);
    if (!who.login) return this.send(ws, { t: "error", why: "Not signed in" });
    try {
      if (m.t === "connect") await this.setConnection(who.login, m.login, true);
      else if (m.t === "disconnect") await this.setConnection(who.login, m.login, false);
      else if (m.t === "ask") await this.ask(ws, who, m);
      else if (m.t === "tag") await this.setTag(who.login, m);
      else if (m.t === "room") await this.setRoom(who.login, m);
      else if (m.t === "say") await this.say(ws, who, m);
      else if (m.t === "flash") await this.flash(ws, who, m);
      else if (m.t === "statsShare") await this.statsShare(who.login, m);
      else if (m.t === "sample") await this.sample(who.login, m.s);
      else if (m.t === "statEvent") await this.statEvent(who.login, m);
      else if (m.t === "answer") await this.answer(ws, who, m);
      else if (m.t === "dismiss") await this.update(ws, who, m.id, (q) => q.to === who.login && !q.answer && !q.dismissed, (q) => (q.dismissed = Date.now()));
      else if (m.t === "seen") await this.update(ws, who, m.id, (q) => q.from === who.login && q.answer && !q.seenAt, (q) => (q.seenAt = Date.now()));
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

  async auth(ws, token) {
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
    const was = this.isOnline(j.login);
    ws.serializeAttachment({ login: j.login, id: j.user_id });
    const user = (await this.ctx.storage.get(`u:${j.login}`)) || { list: [] };
    user.id = j.user_id;
    user.at = Date.now();
    await this.ctx.storage.put(`u:${j.login}`, user);
    await this.sendState(j.login);
    if (!was) await this.tellConnections(j.login);
  }

  async left(ws) {
    const who = ws.deserializeAttachment() || {};
    if (who.login && !this.isOnline(who.login, ws)) await this.tellConnections(who.login);
  }

  sockets(login, except) {
    return this.ctx.getWebSockets().filter((w) => w !== except && w.readyState === 1 && w.deserializeAttachment()?.login === login);
  }

  isOnline(login, except) {
    return this.sockets(login, except).length > 0;
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
      return { login: l, mutual, online: mutual && this.isOnline(l) };
    });
    const requests = Object.entries(users).filter(([l, u]) => l !== login && u.list.includes(login) && !mine.includes(l)).map(([l]) => l);
    const questions = [];
    for (const [k, q] of await this.ctx.storage.list({ prefix: "q:" })) {
      if (Date.now() - q.at > WEEK_MS) await this.ctx.storage.delete(k);
      else if (q.from === login || q.to === login) questions.push(q);
    }
    const rooms = this.roomsFor(login, users);
    const chat = {};
    for (const r of rooms) chat[r.owner] = [...(await this.ctx.storage.list({ prefix: `m:${r.owner}:`, reverse: true, limit: CHAT_BACKLOG })).values()].reverse();
    const stats = {};
    for (const l of [login, ...connections.filter((c) => c.mutual && users[c.login]?.statsOn).map((c) => c.login)]) {
      const rec = await this.ctx.storage.get(`s:${l}`);
      if (rec) stats[l] = workOut(rec);
    }
    this.sendTo(login, { t: "state", me: login, connections, requests, tags: users[login]?.tags || {}, questions, rooms, chat, statsOn: !!users[login]?.statsOn, stats });
  }

  // Who's in an owner's room: them, plus their mutual connections in the
  // room's tag.
  members(owner, users) {
    const o = users[owner];
    if (!o?.room?.tag) return [];
    const tagged = (o.tags?.[o.room.tag] || []).filter((l) => o.list.includes(l) && users[l]?.list.includes(owner));
    return [owner, ...tagged];
  }

  roomsFor(login, users) {
    return Object.keys(users)
      .map((owner) => ({ owner, tag: users[owner].room?.tag, members: this.members(owner, users) }))
      .filter((r) => r.members.includes(login))
      .map((r) => ({ owner: r.owner, tag: r.tag, members: r.members.map((l) => ({ login: l, online: this.isOnline(l) })) }));
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

  async setConnection(login, other, on) {
    other = String(other || "").toLowerCase();
    if (!/^[a-z0-9_]{2,25}$/.test(other) || other === login) return;
    const user = (await this.ctx.storage.get(`u:${login}`)) || { list: [] };
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
    const text = clean(m.text).slice(0, kind === "love" ? MAX_LOVE_LEN : MAX_LEN);
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
      Object.assign(f, { channel, to: channel, chatter: clean(m.chatter).slice(0, 25) });
      // The owner, their mutual connections, and whoever flagged it.
      const owner = users[channel] || { list: [] };
      targets = [...new Set([channel, who.login, ...owner.list.filter((l) => users[l]?.list.includes(channel))])];
      for (const l of targets) this.sendTo(l, { t: "flash", f });
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
    this.send(ws, { t: "flashed", kind, reached: online.length });
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
    const open = (to) => all.filter((q) => q.from === who.login && q.to === to && !q.answer && !q.dismissed).length;
    const full = targets.filter((to) => open(to) >= MAX_OPEN_PER_PAIR);
    if (!everyone && full.length) {
      return this.send(ws, { t: "error", why: `${full[0]} already has ${MAX_OPEN_PER_PAIR} unanswered questions from you` });
    }
    const group = everyone ? crypto.randomUUID().slice(0, 8) : null;
    const options = cleanOptions(m.options);
    let sent = 0;
    for (const to of targets) {
      if (full.includes(to)) continue; // asking everyone skips anyone already full up
      const q = { id: crypto.randomUUID().slice(0, 8), from: who.login, to, text, at: Date.now(), options, answer: null, dismissed: 0, seenAt: 0 };
      if (group) Object.assign(q, { group, toTag: tagName ?? "everyone" });
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
      if (code === "x") return options.includes(`+${text}`);
      return STANDARD.includes(code) && options.includes(code);
    };
    await this.update(ws, who, m.id, (q) => q.to === who.login && !q.answer && !q.dismissed && offered(q), (q) => (q.answer = { code, text, at: Date.now() }));
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

function clean(s) {
  return String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_LEN);
}

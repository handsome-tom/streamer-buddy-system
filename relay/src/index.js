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
// mutual connection, sharing a group id. options are the answer buttons the asker chose: any of
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
//   seen { id }
// Messages to a page:
//   state { me, connections, requests, questions }   (on sign-in, and whenever
//                                                       connections or who's online change)
//   q { q }                 a question that's new or changed
//   error { why }
// A plain "ping" gets "pong" without waking the hub (keeps idle pages cheap).

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LEN = 200;
const MAX_OPEN_PER_PAIR = 3;
const MAX_ASKS_PER_MINUTE = 10;
const STANDARD = ["y", "n", "m", "s", "o", "t"];
const MAX_OPTIONS = 8;
const MAX_OPTION_LEN = 30;

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
    this.sendTo(login, { t: "state", me: login, connections, requests, questions });
  }

  // Someone came online or went away: their mutual connections' pages hear.
  async tellConnections(login) {
    const users = await this.users();
    for (const [l, u] of Object.entries(users)) {
      if (u.list.includes(login) && users[login]?.list.includes(l)) await this.sendState(l);
    }
  }

  async setConnection(login, other, on) {
    other = String(other || "").toLowerCase();
    if (!/^[a-z0-9_]{2,25}$/.test(other) || other === login) return;
    const user = (await this.ctx.storage.get(`u:${login}`)) || { list: [] };
    user.list = on ? [...new Set([...user.list, other])] : user.list.filter((l) => l !== other);
    await this.ctx.storage.put(`u:${login}`, user);
    await this.sendState(login);
    await this.sendState(other);
  }

  // ===== Questions ===========================================================================

  // To one person, or to "*": everyone you're mutually connected with, as one
  // copy each sharing a group id (each answers on their own copy).
  async ask(ws, who, m) {
    const text = clean(m.text);
    if (!text) return;
    const everyone = m.to === "*";
    let targets;
    if (everyone) {
      const users = await this.users();
      targets = (users[who.login]?.list || []).filter((l) => users[l]?.list.includes(who.login));
      if (!targets.length) return this.send(ws, { t: "error", why: "Nobody to ask yet: add people under Connections" });
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
      if (group) q.group = group;
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

// A pretend Twitch for testing custom chat (ownchat.js) on this Mac, including its
// failures, since those can't be caused on demand with the real thing. No installs.
//
//   node dev/mock-twitch.js
//   http://localhost:8789/?demo&livechat&ownchat&mock
//
// Set a pretend sign-in once in that page's console: localStorage.chatToken = '"mock"'
//
// Then make things happen: curl "http://localhost:8789/mock/control?do=<what>"
//   line        a chat message (also: emote, reply, sub, hold, delete, clearuser, clear)
//   feed        a message every second (feedoff stops it)
//   quiet       the connection stays open but stops pinging (it should fail over)
//   drop        closes the connection, and allows reconnecting (it should recover)
//   dropdead    closes the connection and refuses new ones (it should fail over)
//   move        Twitch's "please reconnect here" message (it should carry on, no gap)
//   revoke      Twitch withdraws permission (it should fail over)
//   signout     every API call answers 401 (it should fail over on the next call)
//   nosubs      subscribing is refused, for the next connection (it should fail over)
//   sendbroken  sending answers 500 (it should fail over after the second try)
//   reset       everything back to normal

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = 8789;
const ROOT = path.join(__dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".txt": "text/plain", ".png": "image/png", ".webmanifest": "application/json" };
const SCOPES = ["user:read:chat", "user:write:chat", "user:read:emotes", "moderator:manage:banned_users", "moderator:manage:chat_messages", "moderator:manage:automod"];

let sockets = [];
let flags = {};
let feedTimer = 0;
let n = 0;
const lastIds = [];
const log = [];

function frame(text) {
  const body = Buffer.from(text);
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([head, body]);
}

const CLOSE = Buffer.from([0x88, 0]);
const say = (s, type, payload, sub) => s.write(frame(JSON.stringify({ metadata: { message_type: type, subscription_type: sub }, payload })));
const event = (type, ev) => sockets.forEach((s) => say(s, "notification", { subscription: { type }, event: ev }, type));

function chat(text, opts = {}) {
  const id = `m${++n}`;
  lastIds.push(id);
  const who = opts.who || `viewer${n % 4}`;
  event("channel.chat.message", {
    broadcaster_user_id: "1",
    chatter_user_id: `u-${who}`,
    chatter_user_login: who,
    chatter_user_name: who,
    message_id: id,
    message: { text, fragments: opts.fragments || [{ type: "text", text }] },
    message_type: "text",
    badges: opts.badges || [{ set_id: "moderator", id: "1" }].slice(0, who === "amod" ? 1 : 0),
    color: opts.color ?? "#ff7f50",
    reply: opts.reply || null,
  });
  return id;
}

const controls = {
  line: () => chat(`hello from the pretend chat, line ${n + 1}`),
  html: () => chat(`<img src=x onerror="document.title='HACKED'"><b>not bold</b>`),
  emote: () => chat("Kappa nice", { fragments: [{ type: "emote", text: "Kappa", emote: { id: "25", format: ["static"] } }, { type: "text", text: " nice " }, { type: "mention", text: "@you", mention: { user_login: "you" } }] }),
  reply: () => chat("replying here", { reply: { parent_message_id: lastIds.at(-1), parent_message_body: "the earlier message", parent_user_name: "viewer1" } }),
  sub: () => event("channel.chat.notification", { message_id: `n${++n}`, notice_type: "sub", system_message: "viewer2 subscribed at Tier 1.", message: { text: "", fragments: [] } }),
  hold: () => event("automod.message.hold", { user_id: "u-rude", user_name: "rudeperson", message_id: `h${++n}`, message: { text: "something rude", fragments: [{ type: "text", text: "something rude" }] }, reason: "automod", automod: { category: "swearing", level: 3 } }),
  delete: () => event("channel.chat.message_delete", { message_id: lastIds.at(-1), target_user_id: "x" }),
  clearuser: (q) => event("channel.chat.clear_user_messages", { target_user_id: `u-${q.get("who") || "viewer1"}` }),
  clear: () => event("channel.chat.clear", {}),
  feed: () => {
    clearInterval(feedTimer);
    feedTimer = setInterval(() => chat(`busy chat line ${n + 1}`), Number(1000));
  },
  feedoff: () => clearInterval(feedTimer),
  quiet: () => (flags.quiet = true),
  drop: () => {
    sockets.forEach((s) => s.end(CLOSE));
    sockets = [];
  },
  dropdead: () => {
    flags.refuse = true;
    sockets.forEach((s) => s.end(CLOSE));
    sockets = [];
  },
  move: () => sockets.forEach((s) => say(s, "session_reconnect", { session: { reconnect_url: `ws://localhost:${PORT}/mock/ws?moved=1` } })),
  revoke: () => sockets.forEach((s) => say(s, "revocation", { subscription: { type: "channel.chat.message" } })),
  signout: () => (flags.signout = true),
  nosubs: () => (flags.nosubs = true),
  sendbroken: () => (flags.sendbroken = true),
  hang: () => (flags.hang = true), // subscribing never answers
  badvalidate: () => (flags.badvalidate = true), // checking the sign-in answers 500
  noscript: () => (flags.noscript = true), // ownchat.js is missing
  badscript: () => (flags.badscript = true), // ownchat.js doesn't parse
  throwing: () => (flags.throwing = true), // ownchat.js throws as soon as it starts
  reset: () => {
    flags = {};
    clearInterval(feedTimer);
  },
};

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function api(req, res, url, body) {
  const route = url.pathname.replace("/mock/helix", "");
  log.push({ method: req.method, route, query: url.search, body });
  if (flags.signout) return json(res, 401, { message: "Invalid OAuth token" });
  if (route === "/eventsub/subscriptions" && flags.hang) return;
  if (route === "/eventsub/subscriptions") return flags.nosubs ? json(res, 403, { message: "refused" }) : json(res, 202, { data: [{}] });
  if (route === "/chat/messages") {
    if (flags.sendbroken) return json(res, 500, { message: "Twitch is having a bad time" });
    const sent = JSON.parse(body);
    if (sent.message.includes("dropme")) return json(res, 200, { data: [{ message_id: "", is_sent: false, drop_reason: { code: "msg_duplicate", message: "Your message wasn't sent because it was identical to the last one." } }] });
    const id = chat(sent.message, { who: "you" });
    return json(res, 200, { data: [{ message_id: id, is_sent: true, drop_reason: null }] });
  }
  if (route === "/chat/badges/global" || route === "/chat/badges") return json(res, 200, { data: [] });
  if (route === "/chat/emotes/user") return json(res, 200, { data: [{ id: "25", name: "Kappa", format: ["static"] }, { id: "354", name: "4Head", format: ["static"] }] });
  if (route === "/users") return json(res, 200, { data: [{ id: `u-${url.searchParams.get("login")}`, display_name: url.searchParams.get("login") }] });
  if (route === "/moderation/chat") {
    event("channel.chat.message_delete", { message_id: url.searchParams.get("message_id"), target_user_id: "x" });
    return json(res, 204, {});
  }
  if (route === "/moderation/bans") {
    if (req.method === "POST") event("channel.chat.clear_user_messages", { target_user_id: JSON.parse(body).data.user_id });
    return json(res, 200, { data: [{}] });
  }
  if (route === "/moderation/automod/message") {
    event("automod.message.update", { message_id: JSON.parse(body).msg_id, status: "approved" });
    return json(res, 204, {});
  }
  json(res, 404, { message: `the mock doesn't know ${route}` });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (url.pathname === "/mock/control") {
      controls[url.searchParams.get("do")]?.(url.searchParams);
      return json(res, 200, { ok: true, sockets: sockets.length, flags });
    }
    if (url.pathname === "/mock/log") return json(res, 200, log.splice(0));
    if (url.pathname === "/ownchat.js") {
      if (flags.noscript) return res.writeHead(404).end();
      if (flags.badscript) return res.writeHead(200, { "Content-Type": "text/javascript" }).end("this is not ( javascript");
      if (flags.throwing) return res.writeHead(200, { "Content-Type": "text/javascript" }).end(`window.OwnChat = { SCOPES: ${JSON.stringify(SCOPES)}, start() { throw new Error("pretend bug"); } };`);
    }
    if (url.pathname === "/mock/validate" && flags.badvalidate) return json(res, 500, {});
    if (url.pathname === "/mock/validate") return flags.signout ? json(res, 401, {}) : json(res, 200, { login: "you", user_id: "1", scopes: SCOPES, expires_in: 5000000 });
    if (url.pathname.startsWith("/mock/history")) {
      return json(res, 200, { messages: ["@badges=;color=#00ff7f;display-name=OldViewer;emotes=25:7-11;id=old1;user-id=u-old :oldviewer!oldviewer@oldviewer.tmi.twitch.tv PRIVMSG #you :before Kappa the page opened"] });
    }
    if (url.pathname.startsWith("/mock/helix")) return api(req, res, url, body);
    const file = path.normalize(path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    });
  });
});

server.on("upgrade", (req, socket) => {
  if (flags.refuse) return socket.destroy();
  const accept = crypto.createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on("error", () => {});
  const moved = req.url.includes("moved=1");
  say(socket, "session_welcome", { session: { id: `s${Date.now()}`, keepalive_timeout_seconds: 10 } });
  if (moved) sockets.forEach((s) => s.end(CLOSE)), (sockets = []);
  sockets.push(socket);
  const ping = setInterval(() => {
    if (!flags.quiet) say(socket, "session_keepalive", {});
  }, 5000);
  socket.on("close", () => {
    clearInterval(ping);
    sockets = sockets.filter((s) => s !== socket);
  });
});

server.listen(PORT, () => console.log(`Pretend Twitch: http://localhost:${PORT}/?demo&livechat&ownchat&mock`));

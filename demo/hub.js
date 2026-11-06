// The public demo's engine (demo/index.html). Everything runs in the visitor's own browser,
// so each visitor has a sandbox of their own and nothing reaches the real relay, Twitch or
// anyone's account:
//
//   - The real relay code (relay/src/index.js, the Hub class), with the few Cloudflare
//     pieces it uses stood in for: storage in memory, and sockets that are just objects.
//     Pretend users sign in as "dev:<login>", as on the local test relay.
//   - A pretend Twitch for the streamer's chat dock, like dev/mock-twitch.js: a busy chat
//     feed, who's in the chat, and the few API calls custom chat makes.
//
// window.SANDBOX is what the two panels use (demo/sandbox.js): Socket, fetch and seed.
// The demo page's own buttons use the same sockets, as the pretend people.

import { Hub } from "../relay/src/index.js";

// ===== Sockets ================================================================================
// One object per connection, on the page's side, shaped like a browser WebSocket (on*
// handlers and events). Where it goes is picked from its address: the relay, Twitch's
// EventSub, or Twitch's public chat.
const later = (fn) => setTimeout(fn, 0);
export class Socket extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.protocol = "";
    this.binaryType = "blob";
    this.bufferedAmount = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    later(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this._fire("open", new Event("open"));
      route(this);
    });
  }
  _fire(type, event) {
    this.dispatchEvent(event);
    try {
      this[`on${type}`]?.(event);
    } catch (e) {
      console.error(e);
    }
  }
  _receive(data) {
    if (this.readyState === 1) this._fire("message", new MessageEvent("message", { data }));
  }
  _closed(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this._fire("close", new CloseEvent("close", { code, wasClean: true }));
    this._peer?.gone?.();
  }
  send(data) {
    if (this.readyState !== 1) return;
    later(() => this._peer?.got?.(String(data)));
  }
  close(code = 1000) {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    later(() => this._closed(code));
  }
}
Socket.CONNECTING = 0;
Socket.OPEN = 1;
Socket.CLOSING = 2;
Socket.CLOSED = 3;

function route(socket) {
  const u = new URL(socket.url);
  if (u.pathname.includes("/mock/irc")) return twitch.publicChat(socket);
  if (u.pathname.includes("/mock/ws")) return twitch.eventsub(socket);
  return relay.connect(socket); // the relay (and anything else: never the real one)
}

// ===== The relay ==============================================================================
globalThis.WebSocketRequestResponsePair ||= class {
  constructor(request, response) {
    this.request = request;
    this.response = response;
  }
};

const relay = (() => {
  const store = new Map();
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const storage = {
    async get(key) {
      if (Array.isArray(key)) return new Map(key.filter((k) => store.has(k)).map((k) => [k, clone(store.get(k))]));
      return clone(store.get(key));
    },
    async put(key, value) {
      if (typeof key === "object") for (const [k, v] of Object.entries(key)) store.set(k, clone(v));
      else store.set(key, clone(value));
    },
    async delete(key) {
      if (Array.isArray(key)) return key.filter((k) => store.delete(k)).length;
      return store.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return new Map([...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => [k, clone(store.get(k))]));
    },
  };
  const open = new Set(); // the relay's side of each connection
  const ctx = {
    storage,
    acceptWebSocket: (ws) => open.add(ws),
    getWebSockets: () => [...open],
    setWebSocketAutoResponse: () => {},
  };
  const hub = new Hub(ctx, { DEV_AUTH: "1", TWITCH_CLIENT_ID: "sandbox" });
  // The Hub's validator only takes "dev:<login>" tokens with DEV_AUTH, and wants its client
  // id to match: dev sign-ins carry the env's own id, so this matches.

  function connect(client) {
    const server = {
      readyState: 1,
      attachment: {},
      send(data) {
        if (this.readyState === 1) later(() => client._receive(String(data)));
      },
      close(code) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        open.delete(this);
        later(() => client._closed(code));
      },
      serializeAttachment(v) {
        this.attachment = clone(v);
      },
      deserializeAttachment() {
        return clone(this.attachment);
      },
    };
    ctx.acceptWebSocket(server);
    client._peer = {
      got(data) {
        if (data === "ping") return client._receive("pong"); // the relay's auto-response
        hub.webSocketMessage(server, data).catch((e) => console.error("relay:", e));
      },
      gone() {
        if (server.readyState === 3) return;
        server.readyState = 3;
        open.delete(server);
        hub.webSocketClose(server, 1000, "", true).catch(() => {});
      },
    };
  }
  return { connect };
})();

// ===== The pretend Twitch =====================================================================
const twitch = (() => {
  const eventsubSockets = new Set();
  const chatSockets = new Set();
  const here = new Set(); // who the pretend public chat says is in the chat
  let n = 0;
  const lastIds = [];

  const say = (s, type, payload, sub) => s._receive(JSON.stringify({ metadata: { message_type: type, subscription_type: sub }, payload }));
  const event = (type, ev) => eventsubSockets.forEach((s) => say(s, "notification", { subscription: { type }, event: ev }, type));

  const CHATTERS = ["pixelpanda", "NightOwl_88", "crumbsnacker", "LuckyLlama", "vortexvic", "mossy_rocks", "TheRealDanny", "sleepycat42",
    "Glitchwave", "maplesyrup_eh", "BigTimeTurtle", "quietlurker", "zoomzoom_k", "ferntastic", "captain_crunchy", "OliveBranch"];
  const SHORT = ["lol", "W", "nice", "LETS GO", "oof", "gg", "true", "hi chat", "no way", "clean", "rip", "o7", "yo", "hahaha", "first try?"];
  const MEDIUM = [
    "that was actually so clean", "how is the mic so good today", "wait what just happened", "chat is moving fast tonight",
    "did anyone else hear that", "I joined right on time", "this map is my favourite", "ok that jump was insane",
    "can we get a replay of that", "hydrate check everyone", "who's here from the raid", "back from making food, what did I miss",
  ];
  const LONG = [
    "honestly the way you handled that last fight was so much better than yesterday, the patience is paying off",
    "quick question for later if you have time, what settings are you using for the stream, it looks really smooth tonight",
    "I've been watching for like two years now and this is easily one of the best streams, thanks for always being so chill",
    "not to be a backseat gamer but I think there's a chest behind the waterfall you skipped earlier, no pressure though",
  ];
  const colorOf = {};
  const hue = () => {
    const h = Math.floor(Math.random() * 360) / 360;
    const f = (k) => Math.round(255 * (0.62 - 0.28 * Math.max(-1, Math.min(((k + h * 12) % 12) - 3, 9 - ((k + h * 12) % 12), 1)))).toString(16).padStart(2, "0");
    return `#${f(0)}${f(8)}${f(4)}`;
  };
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  // A chat message, as Twitch sends it to custom chat. A first message in the channel is
  // also marked on Twitch's public chat, the way Twitch really says so (first-msg=1).
  function chat(text, who = pick(CHATTERS), { kind = "text", bits = 0, first = false, badges = [] } = {}) {
    const id = `m${++n}`;
    lastIds.push(id);
    if (lastIds.length > 50) lastIds.shift();
    colorOf[who] ||= hue();
    if (first) ircLine(`@display-name=${who};first-msg=1;id=${id};user-id=u-${who} ${ircUser(who.toLowerCase())} PRIVMSG #streamer :${text}`);
    const fragments = bits ? [{ type: "cheermote", text: `Cheer${bits}` }, { type: "text", text: ` ${text}` }] : [{ type: "text", text }];
    event("channel.chat.message", {
      broadcaster_user_id: "1", chatter_user_id: `u-${who}`, chatter_user_login: who.toLowerCase(), chatter_user_name: who,
      message_id: id, message: { text: bits ? `Cheer${bits} ${text}` : text, fragments }, message_type: kind, badges, color: colorOf[who], reply: null,
      cheer: bits ? { bits } : null,
    });
    if (text.startsWith("!") && who !== BOT) botReply(text, who);
    return id;
  }

  // StreamElements, the chat bot: it answers !commands a moment later, as its own account
  // (a mod, so no mod icons on its lines), the way it does on Twitch.
  const BOT = "StreamElements";
  const BOT_COMMANDS = {
    "!commands": () => "Commands: !discord !socials !schedule !uptime !lurk !hug",
    "!discord": () => "Join the community Discord: discord.gg/your-server",
    "!socials": () => "Follow along: twitter.com/yourname · instagram.com/yourname · tiktok.com/@yourname",
    "!schedule": () => "Live Monday, Wednesday and Friday at 7pm Central",
    "!uptime": () => `The stream has been live for 2 hours ${10 + Math.floor(Math.random() * 49)} minutes`,
    "!lurk": (who) => `${who} is now lurking. Enjoy the stream!`,
    "!hug": (who) => `${who} gives the whole chat a big hug <3`,
  };
  function botReply(text, who) {
    const answer = BOT_COMMANDS[text.split(/\s/)[0].toLowerCase()];
    if (!answer) return;
    colorOf[BOT] = "#5ac8fa";
    setTimeout(() => chat(answer(who), BOT, { badges: [{ set_id: "moderator", id: "1" }] }), 700 + Math.random() * 600);
  }

  // Twitch's notices: raids, subs, gifts, announcements.
  function notice(notice_type, extra = {}) {
    const who = extra.who || pick(CHATTERS);
    const text = extra.text || "";
    event("channel.chat.notification", {
      broadcaster_user_id: "1", chatter_user_id: `u-${who}`, chatter_user_login: who.toLowerCase(), chatter_user_name: who, color: colorOf[who] || hue(),
      message_id: `n${++n}`, notice_type, system_message: extra.system || "", message: { text, fragments: text ? [{ type: "text", text }] : [] },
      ...extra.fields,
    });
  }
  const NEWBIES = ["fresh_fern", "NewHereHi", "pebble_pusher", "WanderingWes", "kettlecorn99", "SoftServeSam", "dewdrop_dev", "MarbleMoth"];
  const RAIDERS = ["CozyCastleTV", "MidnightMango", "TurboTortoise", "PaperCraneLive"];
  const RAIDER_NAMES = ["bean_counter", "StarlitSoda", "gravelgrump", "Mx_Marigold", "tinyhatbandit", "OrbitOtter", "lemonade_larry", "ChunkyMonkeyTV",
    "pocketfox", "WaffleWizard", "dustbunny_dee", "SirLurksALot", "neon_nana", "PlumPudding7", "brick_by_brick", "HoneyBadgerHal"];
  const RAID_LINES = ["RAID HYPE", "hi from the raid!", "we're here!!", "raid raid raid", "hello new streamer o7", "the raid has arrived", "hi chat, we come in peace", "what did we walk into lol", "raid gang o7", "hello from the other stream!"];
  const firstOne = () => {
    const who = pick(NEWBIES);
    chat(pick(["hi everyone, first time here!", "hello! just found this stream", "hey, been lurking, first message", "this is my first time chatting, hi"]), who, { first: true });
    return who;
  }

  let feedTimer = 0;
  function feedOnce() {
    const r = Math.random();
    if (Math.random() < 0.03) firstOne(); // now and then someone new says hello
    else if (Math.random() < 0.04) chat(pick(Object.keys(BOT_COMMANDS))); // or asks the bot something
    else chat(pick(r < 0.45 ? SHORT : r < 0.88 ? MEDIUM : LONG));
    feedTimer = setTimeout(feedOnce, 600 + Math.random() * 3000);
  }

  const ircUser = (who) => `:${who}!${who}@${who}.tmi.twitch.tv`;
  const ircLine = (line) => chatSockets.forEach((s) => s._receive(line));

  const controls = {
    feed() {
      clearTimeout(feedTimer);
      feedOnce();
    },
    feedoff: () => clearTimeout(feedTimer),
    line: () => chat(pick(MEDIUM)),
    join(who) {
      here.add(who);
      ircLine(`${ircUser(who)} JOIN #streamer`);
    },
    part(who) {
      here.delete(who);
      ircLine(`${ircUser(who)} PART #streamer`);
    },
    // A raid: the notice, then the raiders saying hello.
    raid() {
      const from = pick(RAIDERS);
      const count = 8 + Math.floor(Math.random() * 140);
      notice("raid", {
        who: from,
        system: `${count} raiders from ${from} have joined!`,
        fields: { raid: { user_id: `u-${from}`, user_name: from, user_login: from.toLowerCase(), viewer_count: count, profile_image_url: new URL("pics/raider.svg", import.meta.url).href } },
      });
      // The raiders pour in over a few seconds: people from the other channel, about half
      // of them chatting here for the first time.
      const raiders = RAIDER_NAMES.slice().sort(() => Math.random() - 0.5).slice(0, 8 + Math.floor(Math.random() * 5));
      setTimeout(() => raiders.forEach((who) => ircLine(`${ircUser(who.toLowerCase())} JOIN #streamer`)), 400);
      raiders.forEach((who, i) => setTimeout(() => chat(pick(RAID_LINES), who, { first: i % 2 === 0 }), 900 + i * 500 + Math.random() * 300));
      return { from, count };
    },
    first: () => firstOne(),
    command() {
      const who = pick(CHATTERS);
      const cmd = pick(Object.keys(BOT_COMMANDS));
      chat(cmd, who);
      return { who, cmd };
    },
    sub() {
      const who = pick(CHATTERS);
      if (Math.random() < 0.5) notice("sub", { who, system: `${who} subscribed at Tier 1.`, fields: { sub: { sub_tier: "1000", is_prime: false, duration_months: 1 } } });
      else {
        const months = 2 + Math.floor(Math.random() * 30);
        notice("resub", { who, system: `${who} subscribed at Tier 1. They've subscribed for ${months} months!`, text: "love this community", fields: { resub: { cumulative_months: months, sub_tier: "1000" } } });
      }
      return who;
    },
    gift() {
      const who = pick(CHATTERS);
      const total = pick([5, 5, 10, 20]);
      notice("community_sub_gift", { who, system: `${who} is gifting ${total} Tier 1 Subs to the community!`, fields: { community_sub_gift: { id: `g${n}`, total, sub_tier: "1000" } } });
      return { who, total };
    },
    cheer() {
      const who = pick(CHATTERS);
      chat(pick(["great stream!", "for the snack fund", "that play deserved it"]), who, { bits: pick([100, 250, 500, 1000]) });
      return who;
    },
    highlight() {
      const who = pick(CHATTERS);
      chat(pick(["can you say hi to my cat", "HAPPY BIRTHDAY to the streamer!", "this is my highlighted message, hello!"]), who, { kind: "channel_points_highlighted" });
      return who;
    },
    announce() {
      notice("announcement", { who: "mod2", text: "Giveaway at the end of the stream, type !enter to join", fields: { announcement: { color: "GREEN" } } });
    },
    say(who, text) {
      if (!here.has(who)) controls.join(who);
      ircLine(`${ircUser(who)} PRIVMSG #streamer :${text}`);
      chat(text, who);
    },
  };

  function eventsub(socket) {
    eventsubSockets.add(socket);
    say(socket, "session_welcome", { session: { id: `s${Date.now()}`, keepalive_timeout_seconds: 10 } });
    const ping = setInterval(() => say(socket, "session_keepalive", {}), 5000);
    socket._peer = { got() {}, gone: () => (clearInterval(ping), eventsubSockets.delete(socket)) };
  }

  function publicChat(socket) {
    chatSockets.add(socket);
    setTimeout(() => {
      const me = `justinfan${Math.floor(Math.random() * 90000)}`;
      for (const who of [me, ...here]) socket._receive(`${ircUser(who)} JOIN #streamer`);
      // The regulars are in the chat too, like Twitch's list of who's here says.
      const regulars = CHATTERS.map((c) => c.toLowerCase());
      socket._receive(`:${me}.tmi.twitch.tv 353 ${me} = #streamer :${[me, ...here, ...regulars, ...NEWBIES.map((c) => c.toLowerCase())].join(" ")}`);
    }, 300);
    socket._peer = { got() {}, gone: () => chatSockets.delete(socket) };
  }

  const SCOPES = ["user:read:chat", "user:write:chat", "user:read:emotes", "moderator:manage:banned_users", "moderator:manage:chat_messages", "moderator:manage:automod"];
  const json = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  async function api(url, init = {}) {
    const u = new URL(url);
    const path = u.pathname.slice(u.pathname.indexOf("/mock/"));
    const body = typeof init.body === "string" ? init.body : "";
    if (path.startsWith("/mock/validate")) return json(200, { login: "streamer", user_id: "1", scopes: SCOPES, expires_in: 5000000 });
    if (path.startsWith("/mock/history")) return json(200, { messages: [] });
    const route = path.replace("/mock/helix", "");
    if (route === "/eventsub/subscriptions") return json(202, { data: [{}] });
    if (route === "/chat/messages") {
      const sent = JSON.parse(body || "{}");
      const id = chat(String(sent.message || ""), "streamer");
      return json(200, { data: [{ message_id: id, is_sent: true, drop_reason: null }] });
    }
    if (route === "/chat/badges/global" || route === "/chat/badges") return json(200, { data: [] });
    if (route === "/chat/emotes/user") return json(200, { data: [{ id: "25", name: "Kappa", format: ["static"] }, { id: "354", name: "4Head", format: ["static"] }] });
    if (route === "/users") return json(200, { data: [{ id: `u-${u.searchParams.get("login")}`, display_name: u.searchParams.get("login") }] });
    if (route === "/moderation/chat") {
      event("channel.chat.message_delete", { message_id: u.searchParams.get("message_id"), target_user_id: "x" });
      return json(204, {});
    }
    if (route === "/moderation/bans") {
      if ((init.method || "GET") === "POST") {
        const id = JSON.parse(body || "{}").data?.user_id || "";
        event("channel.chat.clear_user_messages", { target_user_id: id, target_user_name: id.replace(/^u-/, ""), target_user_login: id.replace(/^u-/, "").toLowerCase() });
      }
      return json(200, { data: [{}] });
    }
    if (route === "/moderation/automod/message") return json(204, {});
    return json(404, { message: `the demo doesn't do ${route}` });
  }

  return { eventsub, publicChat, api, controls };
})();

// ===== What the panels use (demo/sandbox.js) ==================================================
// Each panel's storage starts with what it needs: the streamer's chat dock uses custom chat
// with a pretend sign-in; Streamer View starts open.
function seed(login) {
  const base = { svOpen: "true" };
  if (login === "streamer") Object.assign(base, { chatToken: JSON.stringify("mock"), ownChat: "true" });
  return base;
}

window.SANDBOX = { Socket, fetch: (url, init) => twitch.api(url, init), seed };
export const pretendTwitch = twitch.controls;

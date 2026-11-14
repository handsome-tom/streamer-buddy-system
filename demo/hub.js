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

import { Hub } from "../relay/src/index.js?v=317"; // the number: bump it when the relay changes, so browsers fetch the new one (and bump hub.js?v= in play.html)

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
    async list({ prefix = "", reverse = false, limit = Infinity } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (reverse) keys.reverse(); // as Cloudflare's: newest first, then the limit
      return new Map(keys.slice(0, limit).map((k) => [k, clone(store.get(k))]));
    },
  };
  const open = new Set(); // the relay's side of each connection
  const ctx = {
    storage,
    acceptWebSocket: (ws) => open.add(ws),
    getWebSockets: () => [...open],
    setWebSocketAutoResponse: () => {},
  };
  const ENV = { DEV_AUTH: "1", TWITCH_CLIENT_ID: "sandbox" };
  let hub = new Hub(ctx, ENV);
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
  // The automatic tests (tests/) start each test on an empty relay: everyone signed out,
  // nothing stored, a fresh hub.
  // extra: more settings for the hub, e.g. { OWNER_LOGIN } to switch the allow list on.
  function reset(extra = {}) {
    for (const server of [...open]) server.close(1000);
    open.clear();
    store.clear();
    hub = new Hub(ctx, { ...ENV, ...extra });
  }
  return { connect, reset };
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

  const CHATTERS = ["hellofoxy", "MacAndCheeseMan", "SneakySneaky", "LuckyLlama", "MiloMunch", "LeonTears", "KidCutter", "sleepycat42",
    "Glitchwave", "BadDog15", "HoneyBuddy", "quietlurker", "zoomzoom_k", "ferntastic", "Captain_Fruit", "OliveBranch"];
  const SHORT = ["lol", "W", "nice", "LETS GO", "oof", "gg", "true", "hi chat", "no way", "clean", "rip", "o7", "yo", "hahaha", "first try?"];
  const MEDIUM = [
    "that was actually so clean", "how is the mic so good today", "wait what just happened", "chat is moving fast tonight",
    "did anyone else hear that", "I joined right on time", "this map is my favorite", "ok that jump was insane",
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
  function chat(text, who = pick(CHATTERS), { kind = "text", bits = 0, first = false, badges = [], reward = false } = {}) {
    const id = `m${++n}`;
    lastIds.push(id);
    if (lastIds.length > 50) lastIds.shift();
    colorOf[who] ||= hue();
    if (first) ircLine(`@display-name=${who};first-msg=1;id=${id};user-id=u-${who} ${ircUser(who.toLowerCase())} PRIVMSG #streamer :${text}`);
    const fragments = bits ? [{ type: "cheermote", text: `Cheer${bits}` }, { type: "text", text: ` ${text}` }] : [{ type: "text", text }];
    event("channel.chat.message", {
      broadcaster_user_id: "1", chatter_user_id: `u-${who}`, chatter_user_login: who.toLowerCase(), chatter_user_name: who,
      message_id: id, message: { text: bits ? `Cheer${bits} ${text}` : text, fragments }, message_type: kind, badges: badges.length ? badges : subBadge(who), color: colorOf[who], reply: null,
      cheer: bits ? { bits } : null,
      channel_points_custom_reward_id: reward ? "rw-demo" : null,
    });
    sentText[id] = { who, text };
    if (text.startsWith("!") && who !== BOT) botReply(text, who);
    return id;
  }

  // StreamElements, the chat bot: it answers !commands a moment later, as its own account
  // (a mod, so no mod icons on its lines), the way it does on Twitch.
  const BOT = "StreamElements";
  const BOT_COMMANDS = {
    "!command": () => "command test", // a plain one for trying it out
    "!commands": () => "Commands: !command !discord !socials !schedule !uptime !lurk !hug",
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

  const sentText = {}; // message id -> { who, text }, for pinning
  let pinned = null;
  let pinTimer = 0;
  let hypeTimer = 0;
  let pollTimer = 0;
  let predTimer = 0;
  const controls = {
    // The tests: the pretend sign-in's permissions (null: all of them).
    scopes(list) {
      scopesOverride = list;
    },
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
      const from = "Lump"; // the raiding streamer (demo/pics/raider.webp)
      colorOf[from] = "#8fd14f"; // Lump's name color, which the raid card takes
      const count = 8 + Math.floor(Math.random() * 140);
      notice("raid", {
        who: from,
        system: `${count} raiders from ${from} have joined!`,
        fields: { raid: { user_id: `u-${from}`, user_name: from, user_login: from.toLowerCase(), viewer_count: count, profile_image_url: new URL("pics/raider.webp", import.meta.url).href } },
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
      const giftId = `g${n}`;
      notice("community_sub_gift", { who, system: `${who} is gifting ${total} Tier 1 Subs to the community!`, fields: { community_sub_gift: { id: giftId, total, sub_tier: "1000" } } });
      // Then each gift lands, a moment apart, as Twitch sends them.
      const lucky = [...CHATTERS, ...NEWBIES].filter((c) => c !== who).sort(() => Math.random() - 0.5);
      for (let i = 0; i < total; i++) {
        const to = lucky[i % lucky.length];
        setTimeout(() => notice("sub_gift", { who, system: `${who} gifted a Tier 1 sub to ${to}!`, fields: { sub_gift: { recipient_user_name: to, recipient_user_login: to.toLowerCase(), sub_tier: "1000", community_gift_id: giftId, duration_months: 1 } } }), 600 + i * 350);
      }
      return { who, total };
    },
    // The pinned message: mod2 pins a welcome for 5 minutes (custom chat looks every 10s).
    pin() {
      const text = "Welcome in! Be kind, no spoilers please. Type !commands to see what the bot can do";
      const id = chat(text, "mod2", { badges: [{ set_id: "moderator", id: "1" }] });
      pinned = {
        message_id: id, broadcaster_id: "1", sender_user_id: "u-mod2", sender_user_login: "mod2", sender_user_name: "mod2",
        pinned_by_user_id: "u-mod2", pinned_by_user_login: "mod2", pinned_by_user_name: "mod2",
        message: { text, fragments: [{ type: "text", text }] }, starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 5 * 60000).toISOString(), updated_at: new Date().toISOString(),
      };
      clearTimeout(pinTimer);
      pinTimer = setTimeout(() => (pinned = null), 5 * 60000);
    },
    // A hype train: it starts, climbs a few levels as people chip in, then ends.
    hype() {
      clearTimeout(hypeTimer);
      const id = `h${++n}`;
      let level = 1;
      let progress = 0;
      const goal = () => 1000 + level * 600;
      const send = (stage) => {
        const expires = new Date(Date.now() + 60000).toISOString();
        event(`channel.hype_train.${stage}`, {
          id, broadcaster_user_id: "1", level, total: level * 1500 + progress, progress, goal: goal(), expires_at: expires, started_at: new Date().toISOString(),
          top_contributions: [{ user_name: "MacAndCheeseMan", type: "bits", total: 900 }, { user_name: "OliveBranch", type: "subscription", total: 500 }],
        });
      };
      send("begin");
      let steps = 0;
      const step = () => {
        steps++;
        progress += 300 + Math.floor(Math.random() * 500);
        if (progress >= goal()) {
          progress -= goal();
          level++;
        }
        if (steps < 12) {
          send("progress");
          hypeTimer = setTimeout(step, 2500);
        } else event("channel.hype_train.end", { id, broadcaster_user_id: "1", level, total: level * 1500 + progress, ended_at: new Date().toISOString() });
      };
      hypeTimer = setTimeout(step, 2000);
    },
    // A poll: votes come in for a while, then it ends with a winner.
    poll() {
      clearTimeout(pollTimer);
      const id = `p${++n}`;
      const choices = [{ id: "a", title: "Boss fight now", votes: 0 }, { id: "b", title: "Explore first", votes: 0 }, { id: "c", title: "Snack break", votes: 0 }];
      const ends = new Date(Date.now() + 30000).toISOString();
      const send = (stage, extra = {}) => event(`channel.poll.${stage}`, { id, broadcaster_user_id: "1", title: "What should we do next?", choices: choices.map((c) => ({ ...c })), ends_at: ends, ...extra });
      send("begin");
      let ticks = 0;
      const tick = () => {
        ticks++;
        for (const c of choices) c.votes += Math.floor(Math.random() * (c.id === "a" ? 9 : 6));
        if (ticks < 10) {
          send("progress");
          pollTimer = setTimeout(tick, 3000);
        } else send("end", { status: "completed", ended_at: new Date().toISOString() });
      };
      pollTimer = setTimeout(tick, 1500);
    },
    // A prediction: people put points on a side, it locks, then a side wins.
    prediction() {
      clearTimeout(predTimer);
      const id = `r${++n}`;
      const outcomes = [{ id: "w", title: "We win this fight", color: "blue", users: 0, channel_points: 0 }, { id: "l", title: "We lose", color: "pink", users: 0, channel_points: 0 }];
      const locks = new Date(Date.now() + 20000).toISOString();
      const send = (stage, extra = {}) => event(`channel.prediction.${stage}`, { id, broadcaster_user_id: "1", title: "Will we beat the boss?", outcomes: outcomes.map((o) => ({ ...o })), locks_at: locks, ...extra });
      send("begin");
      let ticks = 0;
      const tick = () => {
        ticks++;
        for (const o of outcomes) {
          const people = Math.floor(Math.random() * 4);
          o.users += people;
          o.channel_points += people * (50 + Math.floor(Math.random() * 950));
        }
        if (ticks < 7) {
          send("progress");
          predTimer = setTimeout(tick, 2500);
        } else {
          send("lock", { locked_at: new Date().toISOString() });
          predTimer = setTimeout(() => send("end", { status: "resolved", winning_outcome_id: Math.random() < 0.6 ? "w" : "l", ended_at: new Date().toISOString() }), 6000);
        }
      };
      predTimer = setTimeout(tick, 1500);
    },
    // A channel points redemption: a custom reward (some with words typed in), or now and
    // then one of Twitch's own (unlocking an emote).
    redeem() {
      const who = pick(CHATTERS);
      const REWARDS = [
        { title: "Hydrate!", cost: 500 }, { title: "Posture check", cost: 300 }, { title: "Say something nice", cost: 1000, words: true },
        { title: "Pick the next song", cost: 2500, words: true }, { title: "Do 10 push-ups", cost: 5000 },
      ];
      if (Math.random() < 0.2) {
        event("channel.channel_points_automatic_reward_redemption.add", { broadcaster_user_id: "1", user_id: `u-${who}`, user_login: who.toLowerCase(), user_name: who, id: `a${++n}`, reward: { type: "random_sub_emote_unlock", channel_points: 160 }, message: { text: "", fragments: [] } });
        return { who, title: "Unlock a random sub emote" };
      }
      const r = pick(REWARDS);
      const words = r.words ? pick(["you're doing great tonight", "play the lofi one please", "the chat loves you", "something from the 90s!"]) : "";
      if (words) chat(words, who, { reward: true }); // Twitch posts typed-in ones in chat too
      event("channel.channel_points_custom_reward_redemption.add", {
        id: `x${++n}`, broadcaster_user_id: "1", user_id: `u-${who}`, user_login: who.toLowerCase(), user_name: who, user_input: words, status: "unfulfilled",
        reward: { id: `rw-${r.title}`, title: r.title, cost: r.cost, prompt: "" }, redeemed_at: new Date().toISOString(),
      });
      return { who, title: r.title };
    },
    // A watch streak someone shares, as Twitch posts it.
    streak() {
      const who = pick(CHATTERS);
      const n = pick([5, 12, 25, 55, 100]);
      notice("watch_streak", { who, system: `${who} watched ${n} consecutive streams and sparked a watch streak!`, text: pick(["", "never missing one", "BIRD CITY", "here every time o7"]) });
      return { who, n };
    },
    // Someone's total bits reaches a new badge.
    bitsBadge() {
      const who = pick(CHATTERS);
      const tier = pick([1000, 5000, 10000]);
      notice("bits_badge_tier", { who, system: `bits badge tier notification`, fields: { bits_badge_tier: { tier } } });
      return { who, tier };
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
    // A recent line from a viewer (not a bot or a mod), for a mod to flag.
    recentLine() {
      const ids = lastIds.slice().reverse();
      for (const id of ids) {
        const m = sentText[id];
        if (m && m.who !== BOT && !/^mod\d$/.test(m.who) && m.who !== "streamer") return { ...m, color: colorOf[m.who] };
      }
      return null;
    },
    say(who, text) {
      if (!here.has(who)) controls.join(who);
      ircLine(`${ircUser(who)} PRIVMSG #streamer :${text}`);
      // In the demo, mod1 is the streamer's lead moderator (Twitch's hammer badge), mod2 a mod.
      const rank = who === "mod1" ? "lead_moderator" : who === "mod2" ? "moderator" : "";
      chat(text, who, rank ? { badges: [{ set_id: rank, id: "1" }] } : undefined);
    },
  };

  // What Twitch would say about a chatter, made up but the same each time for one name:
  // a picture, when the account was made, whether and since when they follow, a bio, and
  // what they last streamed.
  const BIOS = ["Just here for the vibes.", "Cozy games, late nights, too much tea.", "Lurker by day, lurker by night.", "Speedrunner in training. Mostly falling off ledges.",
    "Artist, cat parent, chronic backseater.", "", "", "Here since the old days o7"];
  const GAMES = ["Just Chatting", "Minecraft", "Stardew Valley", "Elden Ring", "", "", "Art", "Fortnite"];
  const PICS = { lump: "pics/raider.webp", mod1: "pics/mod1.webp", mod2: "pics/mod2.webp", streamer: "pics/streamer.webp" };
  function person(login) {
    const name = [...CHATTERS, ...NEWBIES, ...RAIDER_NAMES, "Lump", "mod1", "mod2", BOT].find((c) => c.toLowerCase() === login.toLowerCase()) || login;
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const day = 86400000;
    const newbie = NEWBIES.includes(name) || RAIDER_NAMES.includes(name);
    const age = newbie ? (20 + (h % 400)) * day : (300 + (h % 2600)) * day;
    const follows = name === BOT ? false : newbie ? h % 3 === 0 : h % 5 !== 0;
    const color = colorOf[name] || "#9147ff";
    const letter = name.replace(/[^a-z]/i, "")[0]?.toUpperCase() || "?";
    const drawn = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 70 70"><rect width="70" height="70" fill="${color}"/><text x="35" y="47" font-family="Arial" font-weight="bold" font-size="34" fill="#18181b" text-anchor="middle">${letter}</text></svg>`)}`;
    return {
      id: `u-${name}`, login: name.toLowerCase(), display_name: name, broadcaster_type: "", type: "",
      description: name === "Lump" ? "🌿 Big green streamer from the swamp! Cozy Minecraft builds every week, horror on Fridays. Raids with love 💚 | Discord: discord.gg/lumpswamp | Business: lump@example.com" : BIOS[h % BIOS.length],
      profile_image_url: PICS[name.toLowerCase()] ? new URL(PICS[name.toLowerCase()], import.meta.url).href : drawn,
      created_at: new Date(Date.now() - age).toISOString(),
      followedAt: follows ? new Date(Date.now() - Math.min(age - day, (5 + (h % 700)) * day)).toISOString() : "",
      game: name === "Lump" || name === "streamer" ? "Minecraft" : GAMES[(h >> 3) % GAMES.length],
      followers: name === "Lump" ? 12437 : 40 + (h % 4800), // the raid card's follower count
      // Tags for the raid card's "you share" (the pretend streamer and Lump overlap a little).
      tags: name === "Lump" ? ["English", "Cozy", "Building", "Wholesome"] : name === "streamer" ? ["English", "Cozy", "Chatting"] : [],
    };
  }
  // Badge pictures, drawn here (Twitch's own are its artwork): a shaded tile in the badge's
  // color with a clean line icon (Lucide, ISC license) on it.
  const MARKS = {
    star: ['<path fill="#fff" d="M12 2.5l2.94 5.96 6.56.95-4.75 4.63 1.12 6.54L12 17.5l-5.87 3.08 1.12-6.54L2.5 9.41l6.56-.95z"/>'],
    sword: ['<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/>', '<path d="m13 19 6-6"/>', '<path d="m16 16 4 4"/>', '<path d="m19 21 2-2"/>'],
    gem: ['<path d="M6 3h12l4 6-10 13L2 9Z"/>', '<path d="M11 3 8 9l4 13 4-13-3-6"/>', '<path d="M2 9h20"/>'],
    crown: ['<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/>', '<path d="M5 21h14"/>'],
    gift: ['<rect x="3" y="8" width="18" height="4" rx="1"/>', '<path d="M12 8v13"/>', '<path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/>', '<path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>'],
    train: ['<path d="M8 3.1V7a4 4 0 0 0 8 0V3.1"/>', '<path d="m9 15-1-1"/>', '<path d="m15 15 1-1"/>', '<path d="M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z"/>', '<path d="m8 19-2 3"/>', '<path d="m16 19 2 3"/>'],
    check: ['<path d="M20 6 9 17l-5-5"/>'],
    hammer: ['<path d="m15 12-8.4 8.4a2 2 0 0 1-2.8-2.8L12.2 9.2"/>', '<path d="m9.6 6.4 8 8"/>', '<path d="M14 3.5 20.5 10l-3 3L11 6.5z"/>'],
  };
  const tile = (bg, mark) => {
    const id = `g${bg.slice(1)}`;
    return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="${bg}" stop-opacity="1"/><stop offset="1" stop-color="${bg}"/></linearGradient><linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".3"/></linearGradient></defs><rect width="36" height="36" rx="6" fill="url(#${id})"/><rect width="36" height="36" rx="6" fill="url(#${id}s)"/><rect x=".75" y=".75" width="34.5" height="34.5" rx="5.4" fill="none" stroke="#000" stroke-opacity=".35" stroke-width="1.5"/><g transform="translate(7.2 7.2) scale(.9)" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${MARKS[mark].join("")}</g></svg>`)}`;
  };
  const badge = (set_id, id, title, bg, mark) => ({ set_id, versions: [{ id, title, image_url_1x: tile(bg, mark), image_url_2x: tile(bg, mark), image_url_4x: tile(bg, mark) }] });
  const BADGES = [
    { set_id: "subscriber", versions: [["0", "Subscriber", "#8a4dff"], ["2000", "Tier 2 Subscriber", "#5c16c5"], ["3000", "Tier 3 Subscriber", "#d4282a"]].map(([id, title, bg]) => ({ id, title, image_url_1x: tile(bg, "star"), image_url_2x: tile(bg, "star"), image_url_4x: tile(bg, "star") })) },
    badge("moderator", "1", "Moderator", "#1f9d3a", "sword"),
    badge("lead_moderator", "1", "Lead Moderator", "#1f9d3a", "hammer"),
    badge("bits", "1000", "cheer 1000", "#7b52e0", "gem"),
    badge("premium", "1", "Prime Gaming", "#1188c4", "crown"),
    badge("sub-gifter", "10", "10 Gift Subs", "#c99418", "gift"),
    badge("hype-train", "1", "Hype Train conductor", "#e5631a", "train"),
    badge("glhf-pledge", "1", "GLHF Pledge", "#2a8f62", "check"),
  ];
  const EXTRA_BADGES = ["bits/1000", "premium/1", "sub-gifter/10", "hype-train/1", "glhf-pledge/1"];
  // Some regulars are subscribed (the badge says which tier and how many months) and wear
  // a couple of other badges.
  const subBadge = (who) => {
    if (!CHATTERS.includes(who)) return [];
    let h = 7;
    for (const ch of who) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const worn = EXTRA_BADGES.filter((_, i) => (h >> (i + 2)) % 3 === 0).slice(0, 3).map((b) => {
      const [set_id, id] = b.split("/");
      return { set_id, id };
    });
    if (h % 3 === 0) return worn;
    const tier = h % 7 === 0 ? "3000" : h % 5 === 0 ? "2000" : "0";
    return [{ set_id: "subscriber", id: tier, info: String(1 + (h % 40)) }, ...worn];
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

  // What the pretend sign-in may do; the tests take one away (controls.scopes) to check the
  // dock behaves the way it must with real Twitch.
  let scopesOverride = null;
  const scopesNow = () => scopesOverride || SCOPES;
  const SCOPES = ["user:read:chat", "user:write:chat", "user:read:emotes", "moderator:manage:banned_users", "moderator:manage:chat_messages", "moderator:manage:automod", "moderator:read:chatters", "moderator:read:followers", "moderator:manage:warnings", "channel:read:hype_train", "channel:read:polls", "channel:read:predictions", "user:manage:whispers", "channel:read:redemptions"];
  const json = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  async function api(url, init = {}) {
    const u = new URL(url);
    const path = u.pathname.slice(u.pathname.indexOf("/mock/"));
    const body = typeof init.body === "string" ? init.body : "";
    if (path.startsWith("/mock/validate")) return json(200, { login: "streamer", user_id: "1", scopes: scopesNow(), expires_in: 5000000 });
    if (path.startsWith("/mock/history")) return json(200, { messages: [] });
    const route = path.replace("/mock/helix", "");
    if (route === "/eventsub/subscriptions") return json(202, { data: [{}] });
    if (route === "/chat/messages") {
      const sent = JSON.parse(body || "{}");
      const id = chat(String(sent.message || ""), "streamer");
      return json(200, { data: [{ message_id: id, is_sent: true, drop_reason: null }] });
    }
    if (route === "/chat/badges/global") return json(200, { data: BADGES });
    if (route === "/chat/badges") return json(200, { data: [] });
    if (route === "/whispers") return json(204, {});
    if (route === "/chat/emotes/user") return json(200, { data: [{ id: "25", name: "Kappa", format: ["static"] }, { id: "354", name: "4Head", format: ["static"] }] });
    if (route === "/users" && u.searchParams.get("id")) return json(200, { data: [person(u.searchParams.get("id").replace(/^u-/, ""))] });
    if (route === "/users") return json(200, { data: [{ id: `u-${u.searchParams.get("login")}`, display_name: u.searchParams.get("login") }] });
    if (route === "/channels/followers") {
      // Without user_id: how many follow a channel (the raid card's follower count). Twitch
      // gives the total to anyone signed in, with an empty list.
      if (!u.searchParams.get("user_id")) {
        const bid = u.searchParams.get("broadcaster_id") || "";
        return json(200, { data: [], total: person(bid === "1" ? "streamer" : bid.replace(/^u-/, "")).followers });
      }
      const p = person(u.searchParams.get("user_id").replace(/^u-/, ""));
      // Like Twitch: without moderator:read:followers, an empty list (not an error).
      if (!scopesNow().includes("moderator:read:followers")) return json(200, { data: [], total: 1 });
      return json(200, { data: p.followedAt ? [{ user_id: p.id, user_login: p.login, user_name: p.display_name, followed_at: p.followedAt }] : [], total: 1 });
    }
    if (route === "/channels") {
      const bid = u.searchParams.get("broadcaster_id");
      const p = person(bid === "1" ? "streamer" : bid.replace(/^u-/, "")); // "1" is the pretend streamer's own channel
      return json(200, { data: [{ broadcaster_id: p.id, broadcaster_name: p.display_name, game_name: p.game, title: "", tags: p.tags }] });
    }
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
    if (route === "/chat/pins") {
      const method = init.method || "GET";
      if (method === "GET") return json(200, { data: pinned ? [pinned] : [] });
      // Pinning a message from the chat: the pretend Twitch remembers it, like Twitch does.
      if (method === "PUT") {
        const id = u.searchParams.get("message_id");
        const said = sentText[id] || {};
        const secs = Number(u.searchParams.get("duration_seconds")) || 0;
        pinned = {
          message_id: id, broadcaster_id: "1", sender_user_id: `u-${said.who || "someone"}`, sender_user_login: (said.who || "someone").toLowerCase(), sender_user_name: said.who || "someone",
          pinned_by_user_id: "1", pinned_by_user_login: "streamer", pinned_by_user_name: "streamer",
          message: { text: said.text || "", fragments: [{ type: "text", text: said.text || "" }] }, starts_at: new Date().toISOString(),
          ends_at: secs ? new Date(Date.now() + secs * 1000).toISOString() : null, updated_at: new Date().toISOString(),
        };
        clearTimeout(pinTimer);
        if (secs) pinTimer = setTimeout(() => (pinned = null), secs * 1000);
        return json(204, {});
      }
      if (method === "DELETE") {
        pinned = null;
        return json(204, {});
      }
    }
    if (route === "/moderation/warnings") {
      // The person is warned; a few seconds later they read it, as Twitch reports.
      const w = JSON.parse(body || "{}").data || {};
      const name = String(w.user_id || "").replace(/^u-/, "");
      event("channel.warning.send", { broadcaster_user_id: "1", moderator_user_id: "1", moderator_user_name: "streamer", user_id: w.user_id, user_login: name.toLowerCase(), user_name: name, reason: w.reason, chat_rules_cited: null });
      setTimeout(() => event("channel.warning.acknowledge", { broadcaster_user_id: "1", user_id: w.user_id, user_login: name.toLowerCase(), user_name: name }), 4000);
      return json(200, { data: [{ broadcaster_id: "1", user_id: w.user_id, moderator_id: "1", reason: w.reason }] });
    }
    // Twitch's list of who's in the chat: the regulars and the lurkers (not raiders yet).
    if (route === "/chat/chatters") return json(200, { data: [...CHATTERS, ...NEWBIES, "mod1", "mod2"].map((c) => ({ user_login: c.toLowerCase(), user_name: c })), pagination: {} });
    return json(404, { message: `the demo doesn't do ${route}` });
  }

  return { eventsub, publicChat, api, controls };
})();

// ===== What the panels use (demo/sandbox.js) ==================================================
// Each panel's storage starts with what it needs: the streamer's chat dock uses custom chat
// with a pretend sign-in; Streamer View starts open.
function seed(login) {
  const base = { svOpen: "true" };
  if (login === "streamer") Object.assign(base, { chatToken: JSON.stringify("mock"), ownChat: "true", colors: JSON.stringify({ streamer: "#ff7f50" }) }); // the streamer's chat color
  // The streamer's custom chat remembers Lump: two raids before and a few visits to chat, so
  // the raid card's "Raided you before" and "Chatted here" have something to show.
  if (login === "streamer") {
    const day = 86400000, now = Date.now();
    base["ocMemory:1"] = JSON.stringify({ since: now - 200 * day, raids: { "u-Lump": [2, now - 24 * day, 54] }, chat: { "u-Lump": [now - 150 * day, now - 9 * day, 14, "lump"] } });
  }
  return base;
}

// say: something said in the pretend chat (the playground's pretend Twitch chat, as the mod).
window.SANDBOX = { Socket, fetch: (url, init) => twitch.api(url, init), seed, say: (who, text) => twitch.controls.say(who, text) };
export const pretendTwitch = twitch.controls;
export const resetRelay = (extra) => relay.reset(extra);

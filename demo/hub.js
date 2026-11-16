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

import { Hub } from "../relay/src/index.js?v=321"; // the number: bump it when the relay changes, so browsers fetch the new one (and bump hub.js?v= in play.html)

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

  const CHATTERS = ["hellofoxy", "MacAndCheeseMan", "SneakySneaky", "TomWasTaken", "MiloMunch", "LeonTears", "CuttyKid", "Amazinghertz",
    "deathdancer", "BigDog15", "HoneyBuddy", "KGTurbo", "PocketMan", "BestieHuman", "CaptainSausage", "SunChaser"];
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
  const colorOf = { mod1: "#3fc98e" }; // BlazeMod420 (the mod you play) keeps one color, the one twitch/shim.js tells StreamSpace
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
      message_id: id, message: { text: bits ? `Cheer${bits} ${text}` : text, fragments }, message_type: kind, badges: badges.length ? badges : who === "streamer" ? [{ set_id: "broadcaster", id: "1" }] : subBadge(who), color: colorOf[who], reply: null,
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
      colorOf[from] = "#dc143c"; // crimson: Lump's name color, which the raid card takes
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
    // A sub, as Twitch posts them: with Prime or at a tier, new or coming back (how many
    // months, the streak if they've kept it going), sometimes with a message.
    // Someone subscribing for the very first time (Twitch's "sub"; coming back is "resub").
    firstSub() {
      const who = pick(NEWBIES.length ? NEWBIES : CHATTERS);
      // A paid sub, so it shows Twitch's sub star (the crown is only for Prime).
      const tier = pick(["1000", "1000", "2000"]);
      notice("sub", { who, system: `${who} subscribed at Tier ${tier[0]}.`, fields: { sub: { sub_tier: tier, is_prime: false, duration_months: 1 } } });
      return who;
    },
    sub() {
      const who = pick(CHATTERS);
      const prime = Math.random() < 0.4;
      const tier = prime ? "1000" : pick(["1000", "1000", "1000", "2000", "3000"]);
      const how = prime ? "with Prime" : `at Tier ${tier[0]}`;
      if (Math.random() < 0.35) notice("sub", { who, system: `${who} subscribed ${how}.`, fields: { sub: { sub_tier: tier, is_prime: prime, duration_months: 1 } } });
      else {
        const months = 2 + Math.floor(Math.random() * 60);
        const streak = Math.random() < 0.6 ? Math.max(2, months - Math.floor(Math.random() * 4)) : 0;
        const text = pick(["love this community", "", "happy to be here o7", "another month LETSGO", "", "best stream on twitch"]);
        notice("resub", { who, system: `${who} subscribed ${how}. They've subscribed for ${months} months${streak ? `, currently on a ${streak} month streak` : ""}!`, text, fields: { resub: { cumulative_months: months, streak_months: streak || null, sub_tier: tier, is_prime: prime } } });
      }
      return who;
    },
    // An ad break 90 seconds from now (the ad timer: countdown, Snooze, then "in progress").
    adSoon() {
      pretendAds.next = Date.now() + 90000;
      pretendAds.snoozes = Math.max(pretendAds.snoozes, 1);
    },
    gift() {
      const who = pick(CHATTERS);
      const total = pick([1, 5, 10, 20, 50]);
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
          top_contributions: [{ user_name: "MacAndCheeseMan", type: "bits", total: 900 }, { user_name: "SunChaser", type: "subscription", total: 500 }],
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
    poll() { startPoll("What should we do next?", ["Boss fight now", "Explore first", "Snack break"], 30); },
    // A prediction: people put points on a side, it locks, then a side wins.
    prediction() { startPred("Will we beat the boss?", ["We win this fight", "We lose"], 20, true); },
    // A channel points redemption: a custom reward (some with words typed in), or now and
    // then one of Twitch's own (unlocking an emote).
    redeem() {
      const who = pick(CHATTERS);
      const REWARDS = [
        { id: "hydrate", title: "Hydrate!", cost: 500 }, { id: "posture", title: "Posture check", cost: 300 }, { id: "nice", title: "Say something nice", cost: 1000, words: true },
        { id: "song", title: "Pick the next song", cost: 2500, words: true }, { id: "pushups", title: "Do 10 push-ups", cost: 5000 },
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
        reward: { id: `rw-${r.id}`, title: r.title, cost: r.cost, prompt: "" }, redeemed_at: new Date().toISOString(),
      });
      return { who, title: r.title };
    },
    // A watch streak someone shares, as Twitch posts it.
    streak() {
      const who = pick(CHATTERS);
      const n = pick([5, 12, 25, 55, 100, 170]);
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
      chat(pick(["great stream!", "for the snack fund", "that play deserved it"]), who, { bits: pick([1, 50, 100, 250, 500, 1000, 5000, 10000, 25000]) });
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
  // Badge pictures: Twitch's own global badges, from Twitch's image server, at the addresses
  // Twitch's chat and its API give for them (the real dock gets the same ones from Twitch).
  // A channel's own subscriber badges are its art, so the pretend channel wears Twitch's
  // standard purple star, as a channel without custom badges does. Twitch's Lead Moderator
  // badge wasn't at hand, so lead mods wear the Moderator badge here.
  const TWITCH_BADGE = (uuid) => ({ image_url_1x: `https://static-cdn.jtvnw.net/badges/v1/${uuid}/1`, image_url_2x: `https://static-cdn.jtvnw.net/badges/v1/${uuid}/2`, image_url_4x: `https://static-cdn.jtvnw.net/badges/v1/${uuid}/3` });
  const badge = (set_id, id, title, uuid) => ({ set_id, versions: [{ id, title, ...TWITCH_BADGE(uuid) }] });
  const SUB_STAR = "5d9f2208-5dd8-11e7-8513-2ff4adfae661";
  const BADGES = [
    { set_id: "subscriber", versions: [["0", "Subscriber"], ["2000", "Tier 2 Subscriber"], ["3000", "Tier 3 Subscriber"]].map(([id, title]) => ({ id, title, ...TWITCH_BADGE(SUB_STAR) })) },
    badge("broadcaster", "1", "Broadcaster", "5527c58c-fb7d-422d-b71b-f309dcb85cc1"),
    badge("moderator", "1", "Moderator", "3267646d-33f0-4b17-b3df-f923a41db1d0"),
    badge("lead_moderator", "1", "Lead Moderator", "3267646d-33f0-4b17-b3df-f923a41db1d0"),
    badge("vip", "1", "VIP", "b817aba4-fad8-49e2-b88a-7cc744dfa6ec"),
    badge("founder", "0", "Founder", "511b78a9-ab37-472f-9569-457753bbe7d3"),
    { set_id: "bits", versions: [{ id: "100", title: "cheer 100", ...TWITCH_BADGE("7695da2c-7e42-4652-9b94-a3f695b0ebfc") }, { id: "1000", title: "cheer 1000", ...TWITCH_BADGE("8e443882-eba2-40ed-aee2-8f66995a4205") }] },
    badge("premium", "1", "Prime Gaming", "bbbe0db0-a598-423e-86d0-f9fb98ca1933"),
    badge("turbo", "1", "Turbo", "bd444ec6-8f34-4bf9-91f4-af1e3428d80f"),
    badge("sub-gifter", "1", "Sub Gifter", "a5ef6c17-2e5b-4d8f-9b80-2779fd722414"),
    badge("hype-train", "1", "Current Hype Train Conductor", "fae4086c-3190-44d4-83c8-8ef0cbe1a515"),
    badge("glhf-pledge", "1", "GLHF Pledge", "3158e758-3cb4-43c5-94b3-7639810451c5"),
  ];
  const EXTRA_BADGES = ["bits/1000", "premium/1", "sub-gifter/1", "bits/100", "turbo/1", "glhf-pledge/1", "hype-train/1"];
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
  // Mod tools: rewards "made with StreamSpace" (the only ones the pretend Twitch lets the dock
  // refund, as the real one does), the chat's modes, and a raid out.
  const OWN_REWARDS = ["rw-hydrate", "rw-posture", "rw-song"];
  let chatSettings = { emote_mode: false, follower_mode: false, follower_mode_duration: null, slow_mode: false, slow_mode_wait_time: null, subscriber_mode: false, unique_chat_mode: false };
  let raidTimer = 0;
  const SCOPES = ["channel:manage:redemptions", "channel:manage:raids", "moderator:manage:chat_settings", "user:read:chat", "user:write:chat", "user:read:emotes", "moderator:manage:banned_users", "moderator:manage:chat_messages", "moderator:manage:automod", "moderator:read:chatters", "moderator:read:followers", "moderator:manage:warnings", "channel:read:hype_train", "channel:read:polls", "channel:read:predictions", "user:manage:whispers", "channel:read:redemptions", "channel:read:ads", "channel:manage:ads",
    "moderator:manage:blocked_terms", "moderator:manage:automod_settings", "moderator:manage:unban_requests", "moderator:read:moderators", "moderator:read:vips",
    "channel:manage:polls", "channel:manage:predictions", "channel:manage:broadcast", "channel:manage:vips", "clips:edit", "channel:edit:commercial"];
  // Pretend ad breaks: the first a couple of minutes in, 90 seconds long, then one every
  // 8 minutes after that; three snoozes, each pushing the next one back 5 minutes.
  const pretendAds = { next: Date.now() + 150000, last: 0, dur: 90, snoozes: 3 };
  function adsNow() {
    const a = pretendAds;
    while (a.next && Date.now() >= a.next) {
      a.last = a.next;
      a.next = a.last + a.dur * 1000 + 8 * 60000;
      a.snoozes = Math.min(3, a.snoozes + 1);
    }
    const sec = (t) => (t ? Math.floor(t / 1000) : null);
    return { next_ad_at: sec(a.next), last_ad_at: sec(a.last), duration: a.dur, preroll_free_time: 0, snooze_count: a.snoozes, snooze_refresh_at: sec(Date.now() + 10 * 60000) };
  }
  // The poll and prediction running now (the demo's buttons and Mod tools share them).
  let curPoll = null, curPred = null;
  function startPoll(title, titles, seconds) {
    clearTimeout(pollTimer);
    const id = `p${++n}`;
    const choices = titles.map((t, i) => ({ id: `c${i}`, title: t, votes: 0 }));
    const ends = new Date(Date.now() + seconds * 1000).toISOString();
    curPoll = { id, title, choices, started_at: new Date().toISOString(), duration: seconds, status: "ACTIVE" };
    const send = (stage, extra = {}) => event(`channel.poll.${stage}`, { id, broadcaster_user_id: "1", title, choices: choices.map((c) => ({ ...c })), ends_at: ends, ...extra });
    curPoll.end = (status) => { clearTimeout(pollTimer); curPoll = null; send("end", { status, ended_at: new Date().toISOString() }); };
    send("begin");
    const tick = () => {
      if (!curPoll || curPoll.id !== id) return;
      choices.forEach((c, i) => (c.votes += Math.floor(Math.random() * (i === 0 ? 9 : 6))));
      if (Date.now() < Date.parse(ends)) { send("progress"); pollTimer = setTimeout(tick, 3000); }
      else curPoll.end("completed");
    };
    pollTimer = setTimeout(tick, 1500);
    return curPoll;
  }
  function startPred(title, titles, seconds, autoResolve) {
    clearTimeout(predTimer);
    const id = `r${++n}`;
    const COLORS = ["blue", "pink", "blue", "pink", "blue"];
    const outcomes = titles.map((t, i) => ({ id: `o${i}`, title: t, color: COLORS[i], users: 0, channel_points: 0 }));
    const locks = new Date(Date.now() + seconds * 1000).toISOString();
    curPred = { id, title, outcomes, created_at: new Date().toISOString(), prediction_window: seconds, status: "ACTIVE" };
    const send = (stage, extra = {}) => event(`channel.prediction.${stage}`, { id, broadcaster_user_id: "1", title, outcomes: outcomes.map((o) => ({ ...o })), locks_at: locks, ...extra });
    curPred.lock = () => { clearTimeout(predTimer); if (curPred) curPred.status = "LOCKED"; send("lock", { locked_at: new Date().toISOString() }); };
    curPred.end = (status, winner) => { clearTimeout(predTimer); curPred = null; send("end", { status, ...(winner ? { winning_outcome_id: winner } : {}), ended_at: new Date().toISOString() }); };
    send("begin");
    const tick = () => {
      if (!curPred || curPred.id !== id || curPred.status !== "ACTIVE") return;
      for (const o of outcomes) {
        const people = Math.floor(Math.random() * 4);
        o.users += people;
        o.channel_points += people * (50 + Math.floor(Math.random() * 950));
      }
      if (Date.now() < Date.parse(locks)) { send("progress"); predTimer = setTimeout(tick, 2500); }
      else {
        curPred.lock();
        if (autoResolve) predTimer = setTimeout(() => curPred?.end("resolved", Math.random() < 0.6 ? outcomes[0].id : outcomes[1].id), 6000);
      }
    };
    predTimer = setTimeout(tick, 1500);
    return curPred;
  }
  const pollOut = (p) => p && { id: p.id, title: p.title, status: p.status, started_at: p.started_at, duration: p.duration, choices: p.choices.map((c) => ({ ...c })) };
  const predOut = (p) => p && { id: p.id, title: p.title, status: p.status, created_at: p.created_at, prediction_window: p.prediction_window, outcomes: p.outcomes.map((o) => ({ ...o })) };
  // The rest of Mod tools: blocked words, AutoMod's level, an unban request waiting, the
  // title and category, VIPs. Every mod action also goes in the mod log (channel.moderate).
  let blocked = [{ id: "bt1", text: "spoilers" }, { id: "bt2", text: "buy followers" }];
  let automodLevel = 1;
  let unbanReqs = [{ id: "ub1", user_id: "u-Gr1efer99", user_login: "gr1efer99", user_name: "Gr1efer99", text: "sorry, it was a joke and it won't happen again", created_at: new Date(Date.now() - 40 * 60000).toISOString() }];
  const vips = new Set(["HoneyBuddy"]);
  let chanTitle = "chill vibes and one very rude boss", chanGame = "Elden Ring";
  const modded = (action, extra = {}) => event("channel.moderate", { broadcaster_user_id: "1", moderator_user_id: "1", moderator_user_login: "streamer", moderator_user_name: "streamer", action, ...extra });
  const nameOf = (id) => String(id || "").replace(/^u-/, "");
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
    if (route === "/channels" && init.method === "PATCH") {
      if (!scopesNow().includes("channel:manage:broadcast")) return json(401, { message: "Missing scope: channel:manage:broadcast" });
      const b = JSON.parse(body || "{}");
      if (b.title != null) chanTitle = b.title;
      if (b.game_id) chanGame = String(b.game_id).replace(/^g-/, "");
      return json(204, {});
    }
    if (route === "/channels" && u.searchParams.get("broadcaster_id") === "1") {
      const p = person("streamer");
      return json(200, { data: [{ broadcaster_id: "1", broadcaster_name: p.display_name, game_name: chanGame, title: chanTitle, tags: p.tags }] });
    }
    if (route === "/channels") {
      const bid = u.searchParams.get("broadcaster_id");
      const p = person(bid === "1" ? "streamer" : bid.replace(/^u-/, "")); // "1" is the pretend streamer's own channel
      return json(200, { data: [{ broadcaster_id: p.id, broadcaster_name: p.display_name, game_name: p.game, title: "", tags: p.tags }] });
    }
    if (route === "/moderation/chat") {
      if (!u.searchParams.get("message_id")) {
        event("channel.chat.clear", { broadcaster_user_id: "1" });
        modded("clear");
        return json(204, {});
      }
      event("channel.chat.message_delete", { message_id: u.searchParams.get("message_id"), target_user_id: "x" });
      return json(204, {});
    }
    if (route === "/moderation/bans") {
      if ((init.method || "GET") === "POST") {
        const id = JSON.parse(body || "{}").data?.user_id || "";
        event("channel.chat.clear_user_messages", { target_user_id: id, target_user_name: id.replace(/^u-/, ""), target_user_login: id.replace(/^u-/, "").toLowerCase() });
        const d = JSON.parse(body || "{}").data || {};
        const who = { user_id: id, user_login: nameOf(id).toLowerCase(), user_name: nameOf(id), reason: d.reason || "" };
        if (d.duration) modded("timeout", { timeout: { ...who, expires_at: new Date(Date.now() + d.duration * 1000).toISOString() } });
        else modded("ban", { ban: who });
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
        // The same message again: just a new length, as Twitch does.
        if (pinned?.message_id === id) {
          const secs = Number(u.searchParams.get("duration_seconds")) || 0;
          pinned = { ...pinned, ends_at: secs ? new Date(Date.now() + secs * 1000).toISOString() : null, updated_at: new Date().toISOString() };
          clearTimeout(pinTimer);
          if (secs) pinTimer = setTimeout(() => (pinned = null), secs * 1000);
          return json(204, {});
        }
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
    // Mod tools.
    if (route === "/channel_points/custom_rewards") return json(200, { data: OWN_REWARDS.map((id) => ({ id })) });
    if (route === "/channel_points/custom_rewards/redemptions" && init.method === "PATCH") {
      if (!scopesNow().includes("channel:manage:redemptions")) return json(401, { message: "Missing scope: channel:manage:redemptions" });
      const rid = u.searchParams.get("reward_id") || "";
      if (!OWN_REWARDS.includes(rid)) return json(403, { message: "The ID in the Client-Id header must match the client ID used to create the custom reward." });
      const status = JSON.parse(body || "{}").status === "CANCELED" ? "canceled" : "fulfilled";
      const id = u.searchParams.get("id");
      event("channel.channel_points_custom_reward_redemption.update", { id, broadcaster_user_id: "1", status, reward: { id: rid } });
      return json(200, { data: [{ id, status: status.toUpperCase(), reward: { id: rid } }] });
    }
    if (route === "/chat/settings") {
      if (init.method === "PATCH") {
        const asked = JSON.parse(body || "{}");
        const pairs = { slow_mode: "slow", follower_mode: "followers", subscriber_mode: "subscribers", emote_mode: "emoteonly", unique_chat_mode: "uniquechat" };
        for (const [k, act] of Object.entries(pairs)) if (k in asked) setTimeout(() => modded(asked[k] ? act : `${act}off`, act === "slow" && asked[k] ? { slow: { wait_time_seconds: asked.slow_mode_wait_time || 30 } } : {}), 50);
        if (!scopesNow().includes("moderator:manage:chat_settings")) return json(401, { message: "Missing scope: moderator:manage:chat_settings" });
        const want = JSON.parse(body || "{}");
        chatSettings = { ...chatSettings, ...want };
        if (want.slow_mode === false) chatSettings.slow_mode_wait_time = null;
        if (want.follower_mode === false) chatSettings.follower_mode_duration = null;
        const s = chatSettings;
        event("channel.chat_settings.update", { broadcaster_user_id: "1", emote_mode: s.emote_mode, follower_mode: s.follower_mode, follower_mode_duration_minutes: s.follower_mode_duration, slow_mode: s.slow_mode, slow_mode_wait_time_seconds: s.slow_mode_wait_time, subscriber_mode: s.subscriber_mode, unique_chat_mode: s.unique_chat_mode });
      }
      return json(200, { data: [{ broadcaster_id: "1", ...chatSettings }] });
    }
    if (route === "/channels/ads") {
      if (!scopesNow().includes("channel:read:ads")) return json(401, { message: "Missing scope: channel:read:ads" });
      return json(200, { data: [adsNow()] });
    }
    if (route === "/channels/ads/schedule/snooze") {
      if (!scopesNow().includes("channel:manage:ads")) return json(401, { message: "Missing scope: channel:manage:ads" });
      adsNow();
      if (!pretendAds.snoozes) return json(429, { message: "No snoozes left" });
      pretendAds.snoozes--;
      pretendAds.next += 5 * 60000;
      const d = adsNow();
      return json(200, { data: [{ snooze_count: d.snooze_count, snooze_refresh_at: d.snooze_refresh_at, next_ad_at: d.next_ad_at }] });
    }
    if (route === "/raids") {
      if (!scopesNow().includes("channel:manage:raids")) return json(401, { message: "Missing scope: channel:manage:raids" });
      clearTimeout(raidTimer);
      if (init.method === "DELETE") return json(204, {});
      // The pretend raid goes after 20 seconds (Twitch's countdown is 90).
      const to = (u.searchParams.get("to_broadcaster_id") || "").replace(/^u-/, "");
      raidTimer = setTimeout(() => event("channel.raid", { from_broadcaster_user_id: "1", from_broadcaster_user_name: "streamer", to_broadcaster_user_id: `u-${to}`, to_broadcaster_user_name: to, viewers: 42 }), 20000);
      return json(200, { data: [{ created_at: new Date().toISOString(), is_mature: false }] });
    }
    // ----- More Mod tools -----
    const need = (scope) => !scopesNow().includes(scope) && json(401, { message: `Missing scope: ${scope}` });
    const M = init.method || "GET";
    if (route === "/moderation/blocked_terms") {
      const no = need("moderator:manage:blocked_terms"); if (no) return no;
      if (M === "POST") {
        const text = JSON.parse(body || "{}").text || "";
        const t = { id: `bt${++n}`, text };
        blocked.unshift(t);
        modded("add_blocked_term", { automod_terms: { action: "add", list: "blocked", terms: [text], from_automod: false } });
        return json(200, { data: [t] });
      }
      if (M === "DELETE") {
        const t = blocked.find((x) => x.id === u.searchParams.get("id"));
        blocked = blocked.filter((x) => x !== t);
        if (t) modded("remove_blocked_term", { automod_terms: { action: "remove", list: "blocked", terms: [t.text], from_automod: false } });
        return json(204, {});
      }
      return json(200, { data: blocked });
    }
    if (route === "/moderation/automod/settings") {
      const no = need("moderator:manage:automod_settings"); if (no) return no;
      if (M === "PUT") automodLevel = JSON.parse(body || "{}").overall_level ?? automodLevel;
      return json(200, { data: [{ broadcaster_id: "1", overall_level: automodLevel }] });
    }
    if (route === "/moderation/unban_requests") {
      const no = need("moderator:manage:unban_requests"); if (no) return no;
      if (M === "PATCH") {
        const req = unbanReqs.find((x) => x.id === u.searchParams.get("unban_request_id"));
        if (!req) return json(404, { message: "That unban request was already answered." });
        unbanReqs = unbanReqs.filter((x) => x !== req);
        const ok = u.searchParams.get("status") === "approved";
        modded(ok ? "approve_unban_request" : "deny_unban_request", { unban_request: { is_approved: ok, user_id: req.user_id, user_login: req.user_login, user_name: req.user_name, moderator_message: "" } });
        return json(200, { data: [{ ...req, status: ok ? "approved" : "denied" }] });
      }
      return json(200, { data: unbanReqs });
    }
    if (route === "/polls") {
      if (M === "POST") {
        const no = need("channel:manage:polls"); if (no) return no;
        const b = JSON.parse(body || "{}");
        return json(200, { data: [pollOut(startPoll(b.title, (b.choices || []).map((c) => c.title), b.duration || 120))] });
      }
      if (M === "PATCH") {
        const no = need("channel:manage:polls"); if (no) return no;
        curPoll?.end("terminated");
        return json(200, { data: [] });
      }
      return json(200, { data: curPoll ? [pollOut(curPoll)] : [] });
    }
    if (route === "/predictions") {
      if (M === "POST") {
        const no = need("channel:manage:predictions"); if (no) return no;
        const b = JSON.parse(body || "{}");
        return json(200, { data: [predOut(startPred(b.title, (b.outcomes || []).map((o) => o.title), b.prediction_window || 120, false))] });
      }
      if (M === "PATCH") {
        const no = need("channel:manage:predictions"); if (no) return no;
        const b = JSON.parse(body || "{}");
        if (!curPred) return json(404, { message: "That prediction already ended." });
        if (b.status === "LOCKED") curPred.lock();
        else if (b.status === "RESOLVED") curPred.end("resolved", b.winning_outcome_id);
        else curPred.end("canceled");
        return json(200, { data: [] });
      }
      return json(200, { data: curPred ? [predOut(curPred)] : [] });
    }
    if (route === "/search/categories") {
      const q = (u.searchParams.get("query") || "").trim();
      const name = q.replace(/\b\w/g, (c) => c.toUpperCase());
      return json(200, { data: q ? [{ id: `g-${name}`, name }] : [] });
    }
    if (route === "/streams") return json(200, { data: [{ id: "s1", user_id: "1", type: "live", started_at: new Date(Date.now() - 3600000).toISOString() }] });
    if (route === "/channels/vips") {
      const no = need("channel:manage:vips"); if (no) return no;
      const name = nameOf(u.searchParams.get("user_id"));
      if (M === "POST") {
        if (vips.has(name)) return json(422, { message: "already a VIP" });
        vips.add(name);
        modded("vip", { vip: { user_id: `u-${name}`, user_login: name.toLowerCase(), user_name: name } });
        return json(204, {});
      }
      if (M === "DELETE") {
        if (!vips.delete(name)) return json(422, { message: "not a VIP" });
        modded("unvip", { unvip: { user_id: `u-${name}`, user_login: name.toLowerCase(), user_name: name } });
        return json(204, {});
      }
      return json(200, { data: [...vips].map((v) => ({ user_id: `u-${v}`, user_name: v })) });
    }
    if (route === "/clips") {
      const no = need("clips:edit"); if (no) return no;
      const id = `DemoClip${++n}`;
      return json(202, { data: [{ id, edit_url: `https://clips.twitch.tv/${id}/edit` }] });
    }
    if (route === "/streams/markers") {
      const no = need("channel:manage:broadcast"); if (no) return no;
      return json(200, { data: [{ id: `m${++n}`, created_at: new Date().toISOString(), description: JSON.parse(body || "{}").description || "", position_seconds: 3600 }] });
    }
    if (route === "/channels/commercial") {
      const no = need("channel:edit:commercial"); if (no) return no;
      const length = JSON.parse(body || "{}").length || 60;
      pretendAds.last = Date.now();
      pretendAds.dur = length;
      pretendAds.next = Date.now() + length * 1000 + 8 * 60000;
      event("channel.ad_break.begin", { broadcaster_user_id: "1", duration_seconds: length, started_at: new Date().toISOString(), is_automatic: false });
      return json(200, { data: [{ length, message: "", retry_after: 480 }] });
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

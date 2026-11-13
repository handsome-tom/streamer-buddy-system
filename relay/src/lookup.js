// Public lookups for StreamSpace (the Chrome extension), through Twitch's official API
// (Helix) with this app's own app token, instead of Twitch's private website API.
// Only public facts about channels, never anyone's sign-in:
//
//   GET /api/channels?logins=a,b,c   pictures, names, live or not, viewers, game, when the
//                                    stream started, and (offline) when they were last live
//   GET /api/chatcolor?login=a       someone's chat name color
//   GET /api/video?id=123            when a VOD's broadcast started, and whose it is
//
// The app token needs a client secret, set once with `npx wrangler@3 secret put
// LOOKUP_CLIENT_SECRET`. If Streamer Buddy's own Twitch app is a Public client (no secret),
// make a second, Confidential app on dev.twitch.tv and also set LOOKUP_CLIENT_ID to its ID.
// Without a secret every lookup answers 503 and StreamSpace just goes without.
//
// Answers are kept in memory for a short while (workers.dev has no shared cache), so many
// people with the same pinned channel cost Twitch one call, not hundreds.

const LOGIN = /^[a-z0-9_]{1,25}$/;
const MAX_LOGINS = 100;
// twitch.tv pages (where the extension's features run), the extension's own pages, and
// this Mac for testing. Not a lock (anything can claim an origin), just keeps casual use off.
const ORIGINS = /^(https:\/\/([a-z0-9-]+\.)?twitch\.tv|chrome-extension:\/\/[a-p]{32}|http:\/\/localhost(:\d+)?)$/;
const TTL = { channel: 60e3, lastLive: 30 * 60e3, color: 10 * 60e3, video: 60 * 60e3 };
const MAX_KEPT = 5000;

const kept = new Map(); // key -> { v, until }
let app = null; // { token, until }

function get(key) {
  const k = kept.get(key);
  if (k && k.until > Date.now()) return k;
  kept.delete(key);
  return null;
}

function keep(key, v, ms) {
  if (kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value); // oldest first
  kept.set(key, { v, until: Date.now() + ms });
}

const clientId = (env) => env.LOOKUP_CLIENT_ID || env.TWITCH_CLIENT_ID;

async function appToken(env, fresh) {
  if (!fresh && app && app.until > Date.now()) return app.token;
  if (!env.LOOKUP_CLIENT_SECRET) throw new Unavailable();
  const r = await fetch(`${env.TWITCH_AUTH_URL || "https://id.twitch.tv"}/oauth2/token`, {
    method: "POST",
    body: new URLSearchParams({ client_id: clientId(env), client_secret: env.LOOKUP_CLIENT_SECRET, grant_type: "client_credentials" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Unavailable();
  app = { token: j.access_token, until: Date.now() + Math.min((j.expires_in || 3600) * 1000, 30 * 864e5) - 60e3 };
  return app.token;
}

class Unavailable extends Error {}

// One Helix call. pairs: [["login", "a"], ["login", "b"]]. A 401 means the token ran out:
// get a new one and try once more.
async function helix(env, path, pairs) {
  const q = new URLSearchParams(pairs);
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${env.TWITCH_API_URL || "https://api.twitch.tv/helix"}/${path}?${q}`, {
      headers: { "Client-Id": clientId(env), Authorization: `Bearer ${await appToken(env, i > 0)}` },
    });
    if (r.status === 401 && i === 0) continue;
    if (r.status === 400 || r.status === 404) return [];
    if (!r.ok) throw new Error(`Twitch answered ${r.status}`);
    return (await r.json()).data || [];
  }
  throw new Unavailable();
}

// Helix gives 300x300 pictures; the 70x70 size of the same picture is a tenth the size.
const small = (url) => (url || "").replace(/-300x300\.(png|jpe?g|gif|webp)$/i, "-70x70.$1");

async function users(env, logins) {
  const need = logins.filter((l) => !get(`u:${l}`));
  for (let i = 0; i < need.length; i += MAX_LOGINS) {
    const found = await helix(env, "users", need.slice(i, i + MAX_LOGINS).map((l) => ["login", l]));
    for (const u of found) keep(`u:${u.login}`, { id: u.id, login: u.login, displayName: u.display_name, avatar: small(u.profile_image_url) }, TTL.channel);
    for (const l of need) if (!get(`u:${l}`)) keep(`u:${l}`, null, TTL.channel); // no such channel (renamed, banned)
  }
  return logins.map((l) => get(`u:${l}`)?.v).filter(Boolean);
}

async function lastLive(env, id) {
  const k = get(`l:${id}`);
  if (k) return k.v;
  const [v] = await helix(env, "videos", [["user_id", id], ["type", "archive"], ["first", "1"]]);
  const at = Date.parse(v?.created_at || "") || 0; // 0: they keep no past broadcasts
  keep(`l:${id}`, at, TTL.lastLive);
  return at;
}

async function channels(env, logins) {
  const us = await users(env, logins);
  const key = `s:${us.map((u) => u.id).sort().join(",")}`;
  let live = get(key)?.v;
  if (!live) {
    live = {};
    if (us.length) for (const s of await helix(env, "streams", [...us.map((u) => ["user_id", u.id]), ["first", "100"]])) live[s.user_id] = { viewers: s.viewer_count || 0, game: s.game_name || "", startedAt: Date.parse(s.started_at) || 0 };
    keep(key, live, TTL.channel);
  }
  return Promise.all(
    us.map(async (u) => {
      const s = live[u.id];
      return { login: u.login, displayName: u.displayName, avatar: u.avatar, live: !!s, viewers: s?.viewers || 0, game: s?.game || "", startedAt: s?.startedAt || 0, lastLive: s ? s.startedAt : await lastLive(env, u.id).catch(() => 0) };
    }),
  );
}

async function chatColor(env, login) {
  const [u] = await users(env, [login]);
  if (!u) return { color: "" };
  const k = get(`c:${u.id}`);
  if (k) return k.v;
  const [c] = await helix(env, "chat/color", [["user_id", u.id]]);
  const v = { color: c?.color || "" };
  keep(`c:${u.id}`, v, TTL.color);
  return v;
}

async function video(env, id) {
  const k = get(`v:${id}`);
  if (k) return k.v;
  const [v] = await helix(env, "videos", [["id", id]]);
  const out = v ? { start: Date.parse(v.created_at) || 0, channel: (v.user_login || "").toLowerCase() } : null;
  keep(`v:${id}`, out, TTL.video);
  return out;
}

function answer(origin, status, body) {
  const headers = { "content-type": "application/json", "cache-control": "no-store", vary: "Origin" };
  if (origin && ORIGINS.test(origin)) headers["access-control-allow-origin"] = origin;
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

export async function lookup(req, env, url) {
  const origin = req.headers.get("Origin") || "";
  if (origin && !ORIGINS.test(origin)) return answer("", 403, { error: "Not from Twitch or StreamSpace" });
  if (req.method === "OPTIONS") return answer(origin, 204, null);
  if (req.method !== "GET") return answer(origin, 405, { error: "GET only" });
  try {
    const p = url.searchParams;
    if (url.pathname === "/api/channels") {
      const logins = [...new Set((p.get("logins") || "").toLowerCase().split(",").filter((l) => LOGIN.test(l)))].slice(0, MAX_LOGINS);
      return answer(origin, 200, { data: logins.length ? await channels(env, logins) : [] });
    }
    if (url.pathname === "/api/chatcolor") {
      const login = (p.get("login") || "").toLowerCase();
      if (!LOGIN.test(login)) return answer(origin, 400, { error: "Which login?" });
      return answer(origin, 200, await chatColor(env, login));
    }
    if (url.pathname === "/api/video") {
      const id = p.get("id") || "";
      if (!/^\d{1,15}$/.test(id)) return answer(origin, 400, { error: "Which video?" });
      return answer(origin, 200, { data: await video(env, id) });
    }
    return answer(origin, 404, { error: "No such lookup" });
  } catch (e) {
    return answer(origin, e instanceof Unavailable ? 503 : 502, { error: e instanceof Unavailable ? "Lookups aren't set up on the relay" : "Twitch didn't answer" });
  }
}

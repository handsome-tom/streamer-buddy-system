// Public Twitch lookups (pictures, chat colors, who's live, when a VOD started) through
// the Streamer Buddy System relay, which asks Twitch's official API with its own app. Used instead
// of Twitch's private website API. No sign-in is sent: these are public facts.
//
//   tbcLookup("channels", { logins: "a,b" })  -> [{ login, displayName, avatar, live,
//                                                 viewers, game, startedAt, lastLive }]
//   tbcLookup("chatcolor", { login: "a" })     -> { color }
//   tbcLookup("video", { id: "123" })          -> { data: { start, channel } | null }
//
// Times are milliseconds (0 when unknown). Rejects if the relay can't be reached or
// isn't set up; every feature using it carries on without.
const TBC_LOOKUP_URL = "https://streamer-buddy-relay.handsome-tom.workers.dev/api/";

function tbcLookup(what, params) {
  return fetch(TBC_LOOKUP_URL + what + "?" + new URLSearchParams(params), { credentials: "omit" }).then((r) => {
    if (!r.ok) throw new Error(`Lookup answered ${r.status}`);
    return r.json();
  }).then((j) => (what === "channels" ? j.data || [] : j));
}

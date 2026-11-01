// The Client ID of the Twitch developer app (dev.twitch.tv/console/apps).
// It isn't a secret: every Twitch sign-in page shows it in its address.
// The app's OAuth Redirect URLs must include this page's address, e.g.
//   https://handsome-tom.github.io/streamer-buddy-system/
//   http://localhost:8787/      (for testing on this Mac)
const TWITCH_CLIENT_ID = "v6pt264d6puelgyjk5nqbph90j25zz";

// The relay every Streamer Buddy System page talks through (relay/ in this
// repo, on Cloudflare). On this Mac, the local test relay (`npx wrangler@3 dev
// --port 8788 --var DEV_AUTH:1` in relay/) is used instead.
const RELAY_URL = location.hostname === "localhost"
  ? "ws://localhost:8788/ws"
  : "wss://streamer-buddy-relay.handsome-tom.workers.dev/ws";

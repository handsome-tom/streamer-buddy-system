# Ask the Streamer — OBS dock

A panel for OBS that shows **Ask the Streamer** questions from Twitch Space
users, so the streamer can answer without leaving OBS. Answers go back as
whispers, and the asker sees them as cards in Twitch Space, same as before.

It talks to Twitch Space with the same tagged whispers, so nothing changes on
the asker's side.

## For the streamer: adding it to OBS

1. In OBS, open **Docks → Custom Browser Docks…**
2. Give it a name (for example `Questions`) and paste this address:
   `https://handsome-tom.github.io/twitch-space-obs-dock/`
3. Click **Apply**. The new panel appears; drag it above your chat dock.
4. In the panel, click **Sign in with Twitch** and allow it.
5. Click **Connections** and add the Twitch usernames of the people who may
   ask you. They need to have you in their Twitch Space connections too.

Things to know:

- Questions only arrive **while OBS is open**. A question sent while OBS is
  closed still reaches you as a normal Twitch whisper, but won't show here.
- Twitch needs a **verified phone number** on your account before it lets the
  dock send your answers (Twitch Settings → Security and Privacy).
- If the sign-in runs out, the panel says so; click Sign in with Twitch again.

## For the developer

- `config.js` holds the Twitch app's Client ID (not a secret).
- The Twitch app's **OAuth Redirect URLs** must list every address the page is
  opened from: the GitHub Pages address above, and `http://localhost:8787/`
  for local testing (`python3 -m http.server 8787`).
- Open the page with `?demo` to try the cards without signing in.
- Receiving uses an EventSub WebSocket (`user.whisper.message`); sending uses
  `POST /helix/whispers`. Scopes: `user:read:whispers user:manage:whispers`.

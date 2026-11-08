# Streamer Buddy System

Streamer Buddy System is a panel for OBS that shows **Ask the Streamer**
questions from Twitch Space users, so the streamer can answer without leaving
OBS. Answers go back as whispers, and the asker sees them as cards in Twitch
Space, same as before.

It talks to Twitch Space with the same tagged whispers, so nothing changes on
the asker's side.

## What this is, and what it isn't

| Name | What it is | Where |
| --- | --- | --- |
| **Streamer Buddy System** | This project: a web page used as an OBS dock | this repo |
| **Twitch Space** | The Chrome extension (formerly MytwitchTom) | its own repos |
| **Ask the Streamer** | A feature of Twitch Space; Streamer Buddy System answers its questions | inside Twitch Space |

Always say the full name, **Streamer Buddy System**. This project shares no code
with Twitch Space; only the whisper format is shared.

## For the streamer: adding it to OBS

1. In OBS, open **Docks → Custom Browser Docks…**
2. Give it a name (for example `Streamer Buddy System`) and paste this address:
   `https://handsome-tom.github.io/streamer-buddy-system/`
3. Click **Apply**. The new panel appears; drag it above your chat dock.
4. In the panel, click **Sign in with Twitch** and allow it.
5. Click **Connections** and add the Twitch usernames of the people who may
   ask you. They need to have you in their Twitch Space connections too.

To have Twitch chat in the same panel, use this address instead and close OBS's
own chat dock: `https://handsome-tom.github.io/streamer-buddy-system/?livechat`.
A slim bar stays at the top, made for being live: it shows questions, quick
info and !vanish notes as they come in. Sending starts from whoever you last sent
to. What reads as a question goes with the answer buttons; anything else goes as a
plain message they can mark seen, and you get a notice in the bar when someone marks
your message or answer seen. A connection's picture shows once they've been in the
chat this stream. While they're in the chat, its ring is how recently they chatted:
green within 5 minutes, then orange (10), yellow (20) and white (30); after that, or if
they're just lurking, no ring, just their picture lit up. Once they leave the chat the
picture goes gray. Below it is Twitch's own embedded chat, unchanged. A line a mod flags in Chrome is pinned at the top of the chat, emotes included,
for 10 seconds (5 minutes elsewhere), and with custom chat the line itself glows in the
chat in the flagger's color; the streamer or a mod can clear the pin for everyone with
its X. With custom chat the streamer can also **bookmark** a message for later with its 🔖
button (on hover); the 🔖 count in the chat bar goes back to them. **One click** on a
message puts an orange line under it, right across the chat, to mark where they were;
clicking another moves it, clicking the same one again takes it away.

What's waiting shows on one card under the bar. Questions are answered with ♥, ✓, ✗ or
? (maybe), or a typed reply; the small × in its corner dismisses anything without
answering. With several, they take turns, small ‹ › arrows flip through them, and a quiet
"1 of 3" sits under the buttons. At the top right: a green **chat bubble** (closes any
menu and goes straight back to chat), the **Do Not Disturb** hand (for 15 minutes or
until it's clicked off: no sounds, no glow and no card meanwhile; everything still
arrives and waits, and mods see "Do Not Disturb" in Streamer View), **Connections**, and
the Settings gear.

**Connections** (both sides) lists everyone you've added with their picture; clicking
someone opens a private chat only the two of you see, with the box to type in always at
the bottom. Their tags sit on the right, with a + to add one. Unread private messages
show as a count on the Connections icon; a streamer's room for one of their tags is
opened from there too.

### Pings

When someone needs the streamer, a thin, faint line glows green round the edge of the
panel and it pings once. The glow (and the one behind the bar's message) lasts a couple
of seconds and fades down to almost nothing. If it's still unanswered it comes back up
after 15 seconds, then every 10, resting a touch brighter in between, so it reminds
without badgering. This works over either chat. Nothing climbs by itself: if a
question isn't answered, the person who asked can **Nudge** it (on their waiting
question, or in Streamer View). Each nudge moves it up a color on the streamer's screen
with one softer reminder beep and a brief flash of the edge:

| | Glow | Ping |
| --- | --- | --- |
| Asked | Green | one clear note |
| 1st nudge | Orange | one softer reminder |
| 2nd nudge | Yellow | one softer reminder |
| 3rd nudge | White | one softer reminder |
| Warning | Red | two quick, louder notes |

Three nudges at most, and at most one every 15 seconds. While it can't be nudged (just
nudged, or already white), tapping **Nudge** six times quickly sends the streamer a
**warning**: a heads-up that something needs attention right now (a mod looking out
for the streamer, not a mark against anyone). It shows red on the streamer's screen with a louder double beep (even with reminders
off), at most one every 30 seconds. Answering, dismissing or marking
it seen stops it. The bar shows the most urgent message first.

Anything over an hour old when the panel first shows it doesn't ping or glow, unless
it's nudged after that. The sound is on by default in OBS panels. **If OBS captures your
desktop audio, viewers may hear it**; the switch is under Connections and in Settings.

**Settings** (the gear at the top right of the OBS docks): sound on or off, volume (quiet,
normal, loud), the softer nudge beeps, the edge glow, the quick-questions row, custom
chat or Twitch's, custom chat's text size, and whether to share Streamer View with your
connections. They're kept in OBS between restarts.

### Streamer View (for mods, in the Chrome side panel)

The top of the handshake side panel shows what the streamer's OBS dock is showing right
now: the edge's glow color, everything waiting for them (from anyone, each with how far
it has glowed), answers they haven't marked seen yet, and the quick notes and flagged
chat lines in their bar. It follows the channel open in the Twitch tab beside the panel;
with more than one streamer sharing, a picker switches between them. It can be folded
away by its title. Your own questions, messages, notes and flagged lines in it have an ×
that takes them back off the streamer's dock, while they're still unanswered or unseen.
Above the mod's own lists, **Clear all** puts everything away at once.

The streamer's dock sends this to the relay whenever it changes, and the relay passes it
to their mutual connections only. It disappears when the dock closes, and while the
streamer is set to Offline. Every mutual connection sees everything waiting, including
other people's questions.

### Custom chat (on by default)

The chat dock (`?livechat`) draws the chat itself instead of embedding Twitch's. It's
what lets the chat do things of its own. It asks for one extra Twitch sign-in, kept
separate from the ordinary one and never sent to the relay. Settings → Chat switches
between Custom and Twitch's; `&ownchat=off` in the address turns custom chat off.

Before each viewer's name, Twitch-style mod icons: ban (a second click within 3 seconds),
time out for 10 minutes, and delete, while you're a mod there (Settings can hide them).
When another mod bans or times someone out, a line says so (Twitch doesn't say which, or who).

Twitch's own events show the way Twitch's chat shows them: raids (who, how many viewers,
their picture, and a Welcome them button that fills in a welcome to send), subs and resubs,
gifted subs, bits badge tiers, announcements in their color, cheers (a bits tag),
channel-points highlighted messages and gigantified emotes. First-time chatters are marked
in green with "First-time chatter", as Twitch marks them for mods: Twitch only says so on
its public chat (the `first-msg` tag), so the page's own public-chat connection (the one
for who's here) asks for tags and passes those on.

Switching between custom chat and Twitch's (Settings, or the link above the chat) never
loses messages: both stay running, and switching only changes which one shows. Custom
chat keeps collecting while Twitch's is on screen, and Twitch's chat is loaded in the
background as soon as the dock opens, so it already has everything since then.

It does: messages, Twitch, 7TV, BTTV and FFZ emotes, an emote picker, Tab to finish a
name or emote, badges, replies, subs and other notices, delete, timeout, ban and undo,
AutoMod holds, and the last 50 messages when it opens. A purple edge marks your
connections.

**It always falls back to Twitch's own chat.** That happens by itself, with the reason
and anything unsent shown above the chat, when custom chat can't load or connect, hears
nothing from Twitch for 20 seconds, stops getting messages that Twitch's public chat
connection is still seeing, loses its sign-in, can't send twice in a row, or keeps
hitting errors. It then stays on Twitch's chat (for 30 minutes, even through a reload)
until you press **Try custom chat again**, so it won't flip back and forth while you're
live. **Use Twitch chat** at the top switches by hand at any time.

Chat commands like `/me` and `/slow` aren't run: they're stopped and not sent, so they
can't post into chat as plain text. `/ban`, `/unban` and `/timeout` work.

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
- **Public demo:** https://handsome-tom.github.io/streamer-buddy-system/demo/ shows a mod's
  side panel and the streamer's OBS dock side by side, with pretend people and buttons to
  make things happen. It all runs in the visitor's browser (`demo/hub.js` runs the real
  relay code with in-memory stand-ins, plus a pretend Twitch), the two panels get storage
  of their own (`demo/sandbox.js`), so it never touches the real relay, Twitch or anyone's
  saved sign-in, and every visitor has a sandbox of their own.
- `dev/mock-twitch.js` is a pretend Twitch for testing custom chat, including making it
  fail on purpose. How to use it is at the top of that file.
- `dev/sim.html` puts a mod's side panel and the streamer's OBS chat dock side by side,
  talking through the local relay as pretend users, with buttons to send chat lines and
  questions. Start relay-local, streamer-buddy-local and mock-twitch, then open
  `http://localhost:8789/dev/sim.html`.
- On localhost the pretend users (streamer, streamer2, mod1, mod2) get pictures from
  `dev/memes/<login>.png` if you put some there (the folder is kept out of git), so a
  glowing ring is easy to tell from a plain one. Real sign-ins never use them.
- Receiving uses an EventSub WebSocket (`user.whisper.message`); sending uses
  `POST /helix/whispers`. Scopes: `user:read:whispers user:manage:whispers`.

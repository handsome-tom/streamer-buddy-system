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
chat this stream: bright while they're there, faded after they leave. Its ring is how
recently they chatted: green within 5 minutes, then orange (10), yellow (20), and
white if they're just lurking. Below it is Twitch's own embedded chat, unchanged. A line a mod flags in Chrome is pinned at the top, emotes included, for 5
minutes; the streamer or a mod can clear it for everyone with its X.

### Pings

When someone needs the streamer, the whole edge of the panel glows and it pings. This
works over either chat. If it isn't dealt with, it climbs:

| Time | Glow | Pings |
| --- | --- | --- |
| Right away | Green | 1 |
| 2 minutes | Orange, flashing | 2 |
| 4 minutes | Yellow, flashing | 3 |
| 5 minutes | White, flashing | 4 |

The sender picks how far it can go under **How far it goes** in the Ask box: **Green** is
one ping and stays green, **White** goes all the way. Anything sent without a choice goes
all the way if it's a question, and stays green if it's a plain message. Answering,
dismissing or marking it seen stops it. The bar shows the most urgent message first.

The clock starts when the panel first shows the message, so something sent while OBS was
closed starts at green, and anything over an hour old by then doesn't ping at all. The
sound is on by default in OBS panels. **If OBS captures your desktop audio, viewers may
hear it**; the switch is under Connections.

### Streamer View (for mods, in the Chrome side panel)

The top of the handshake side panel shows what the streamer's OBS dock is showing right
now: the edge's glow colour, everything waiting for them (from anyone, each with how far
it has glowed), answers they haven't marked seen yet, and the quick notes and flagged
chat lines in their bar. It follows the channel open in the Twitch tab beside the panel;
with more than one streamer sharing, a picker switches between them. It only shows; it
can be folded away by its title.

The streamer's dock sends this to the relay whenever it changes, and the relay passes it
to their mutual connections only. It disappears when the dock closes, and while the
streamer is set to Offline. Every mutual connection sees everything waiting, including
other people's questions.

### Custom chat (optional)

Add `&ownchat` to the address (`...?livechat&ownchat`) to have this page draw the chat
itself instead of embedding Twitch's. It's what lets the chat do things of its own. It
asks for one extra Twitch sign-in, kept separate from the ordinary one and never sent to
the relay. `&ownchat=off` switches it off again.

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
- `dev/mock-twitch.js` is a pretend Twitch for testing custom chat, including making it
  fail on purpose. How to use it is at the top of that file.
- Receiving uses an EventSub WebSocket (`user.whisper.message`); sending uses
  `POST /helix/whispers`. Scopes: `user:read:whispers user:manage:whispers`.

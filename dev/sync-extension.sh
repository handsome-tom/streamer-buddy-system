#!/bin/sh
# Copies StreamSpace's chat scripts into the Testing Playground's pretend Twitch chat
# (demo/twitch/ext/), so it shows exactly what the extension does to Twitch's chat.
# Run it again after changing any of these in the extension, then bump version.txt.
#   sh dev/sync-extension.sh
set -e
cd "$(dirname "$0")/.."
SRC="${EXTENSION_DIR:-../twitch extesion/v2-hover}"
[ -f "$SRC/manifest.json" ] || { echo "Can't find the extension at $SRC (set EXTENSION_DIR)"; exit 1; }
for f in backup.js settings.js lookup.js people.js myname.js phrases.js hub.js flag.js chatnotes.js styles.css; do
  cp "$SRC/$f" demo/twitch/ext/
done
# On twitch.tv these scripts skip frames (Twitch's own embeds); the playground's pretend chat
# is a frame of its own, so there (where shim.js has set window.TWITCH_ME) they run as the page.
for f in demo/twitch/ext/*.js; do
  sed -i.bak -e 's/window\.top !== window/(window.top !== window \&\& !window.TWITCH_ME)/g' \
             -e 's/window\.top === window/(window.top === window || !!window.TWITCH_ME)/g' "$f"
  rm -f "$f.bak"
done
VER=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$SRC/manifest.json" | head -1)
echo "$VER" > demo/twitch/ext/VERSION
echo "Copied StreamSpace $VER's chat scripts into demo/twitch/ext/"

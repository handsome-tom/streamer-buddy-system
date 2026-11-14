// Keeping what you've saved (backup.js).
//
// StreamSpace is installed from a folder ("Load unpacked"), and Chrome ties an
// extension's saved things to that one install: remove the card, or load it
// again from a different folder, and your quick phrases, highlight words,
// chatter notes, pinned emotes and channels, starred rewards, streaks and
// markers are gone. Two ways round that:
//
//  * On every twitch.tv page, a copy of your saved things is kept in the page's
//    own localStorage (the site's storage, which stays put whatever happens to
//    the extension). A freshly installed StreamSpace finds that copy and takes
//    it back the first time Twitch loads. (settings.js runs this.)
//  * Back up and Restore in the icon's pop-up save the same copy to a file and
//    read it back, for moving to another browser or computer.
//
// Caches that rebuild themselves and anything private (the account switcher's
// saved cookies, sign-ins) are left out. Used by settings.js and switches.js.

const TBC_BACKUP_KEY = "tbcBackup"; // in twitch.tv's localStorage
const TBC_BACKUP_SKIP = new Set([
  "accounts", "accountAdding", "hubToken", "modChannels",                    // private
  "tbcInstalled", "featureList", "streakSaverTab", "streakSaverState",       // this install only
  "streakSaverFailed", "streakSamples",
  "emoteImages", "emoteOwners", "emoteChannels", "buddyPics", "follows",      // caches
  "followsByAccount", "buddies", "buddySeen", "buddyLeader", "myChatColor",
]);
// ("watch:channel" is this broadcast's minutes so far; it's saved every few seconds and is over when the stream is.)
const tbcBackupSkips = (k) => TBC_BACKUP_SKIP.has(k) || k.startsWith("watch:");

// Everything worth keeping, as { app, version, saved, local: {...}, sync: {...} }.
async function tbcBackupCollect() {
  const keep = (all) => Object.fromEntries(Object.entries(all).filter(([k]) => !tbcBackupSkips(k)));
  const local = keep(await chrome.storage.local.get(null));
  let sync = {};
  try {
    sync = keep(await chrome.storage.sync.get(null));
  } catch {}
  return { app: "StreamSpace", version: chrome.runtime.getManifest().version, saved: new Date().toISOString(), local, sync };
}

// Puts a collected copy back. Returns how many things it restored.
async function tbcBackupApply(data) {
  // (Copies made before the rename, as Twitch Space, still come back.)
  if (!data || !["StreamSpace", "StreamerSpace", "Twitch Space"].includes(data.app) || typeof data.local !== "object") throw new Error("not a StreamSpace backup");
  const local = Object.fromEntries(Object.entries(data.local).filter(([k]) => !tbcBackupSkips(k)));
  const sync = Object.fromEntries(Object.entries(data.sync || {}).filter(([k]) => !tbcBackupSkips(k)));
  if (Object.keys(local).length) await chrome.storage.local.set(local);
  if (Object.keys(sync).length) {
    try {
      await chrome.storage.sync.set(sync);
    } catch {} // sync storage off or full; pinned emotes can be pinned again
  }
  return Object.keys(local).length + Object.keys(sync).length;
}

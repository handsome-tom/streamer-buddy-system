// Active mods: which mods are chatting in this channel right now, for the side panel's Mod
// section (Streamer Buddy System's "Active mods" list). Every chat line with a Moderator or
// Lead Moderator badge notes who said it and when; anyone heard in the last 30 minutes is
// kept in chrome.storage.local "chatMods" as { channel: { login: timeMs } }, and the side
// panel (hub-panel.js) hands the open channel's list to the hub, which rings each mod's
// picture by how long ago they chatted and grays out the ones who haven't.
//
// Only names and times, only on this computer. VOD chat replay doesn't count.
//
// Wrapped so its names don't clash with the other scripts, and only started if it's
// switched on (settings.js).
whenOn("chatmods", "Show which mods are in chat (side panel)", () => {
  if ((window.top !== window && !window.TWITCH_ME)) return; // Twitch's own embeds

  const WINDOW_MS = 30 * 60 * 1000;
  // Chat bots wear the mod badge too; they aren't people to message.
  const BOTS = new Set(["streamelements", "nightbot", "moobot", "fossabot", "streamlabs", "wizebot", "botrixoficial", "sery_bot", "soundalerts", "pokemoncommunitygame", "kofistreambot", "commanderroot", "streamlootsbot", "blerp", "own3d", "frostytoolsdotcom", "tangiabot"]);
  const NOT_CHANNELS = /^(directory|videos|settings|search|subscriptions|inventory|wallet|drops|downloads|following|embed|p|u|turbo|messages|login|signup)$/;
  function channelName() {
    const parts = location.pathname.split("/").filter(Boolean);
    const name = (parts[0] === "popout" || parts[0] === "moderator" ? parts[1] : parts[0])?.toLowerCase();
    if (parts.includes("videos") || parts[1] === "clip") return null; // replays and clips: not live chat
    return name && /^[a-z0-9_]{2,25}$/.test(name) && !NOT_CHANNELS.test(name) ? name : null;
  }

  let heard = {}; // channel -> { login: timeMs }, what's been noticed since the last save
  let saveTimer = 0;
  function note(channel, login) {
    (heard[channel] ||= {})[login] = Date.now();
    if (!saveTimer) saveTimer = setTimeout(save, 3000); // a busy chat saves every few seconds, not every line
  }
  function save() {
    saveTimer = 0;
    const fresh = heard;
    heard = {};
    chrome.storage.local.get("chatMods", ({ chatMods }) => {
      const all = chatMods && typeof chatMods === "object" ? chatMods : {};
      for (const [ch, who] of Object.entries(fresh)) all[ch] = { ...(all[ch] || {}), ...who };
      // Drop anyone not heard from in 30 minutes, and channels left empty.
      const cut = Date.now() - WINDOW_MS;
      for (const ch of Object.keys(all)) {
        for (const [login, at] of Object.entries(all[ch] || {})) if (!(at > cut)) delete all[ch][login];
        if (!Object.keys(all[ch] || {}).length) delete all[ch];
      }
      chrome.storage.local.set({ chatMods: all });
    });
  }

  // A chat line said by a mod: the badge's alt text is "Moderator" or "Lead Moderator".
  function look(line) {
    if (!line.matches?.(".chat-line__message") || line.dataset.tbcModSeen) return;
    line.dataset.tbcModSeen = "1";
    const badges = [...line.querySelectorAll("img.chat-badge")].map((b) => b.alt || "");
    if (!badges.some((a) => /moderator/i.test(a))) return;
    const login = (line.querySelector('[data-a-target="chat-message-username"]')?.dataset.aUser || line.dataset.aUser || "").toLowerCase();
    const channel = channelName();
    if (login && channel && /^[a-z0-9_]+$/.test(login) && !BOTS.has(login)) note(channel, login);
  }

  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches(".chat-line__message")) look(n);
        else n.querySelectorAll?.(".chat-line__message").forEach(look);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  document.querySelectorAll(".chat-line__message").forEach(look);
});

// The hub: a handshake button in Twitch's top bar (just right of the search
// box), and a smaller, quieter one in the chat header (just left of Twitch's
// "Users in Chat" community button). Either opens Streamer Buddy System, the separate hub project
// (github.com/handsome-tom/streamer-buddy-system), in Chrome's side panel
// (hub.html), like Claude's extension. That's where you and the streamer (and
// anyone else you've connected with) ask each other quick questions, see who's
// online, and see what's been answered and seen.
//
// Wrapped so its names don't clash with the other scripts, and only started if
// it's switched on (settings.js).
whenOn("hub", "Streamer Buddy System (handshake button)", () => {
  if ((window.top !== window && !window.TWITCH_ME)) return;

  // A handshake, drawn as lines (from the Lucide icon set, ISC licence).
  const ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/>' +
    '<path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/></svg>';

  function button(extra) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `tbc-hubbtn ${extra}`;
    b.title = "Streamer Buddy System";
    b.setAttribute("aria-label", "Streamer Buddy System");
    b.innerHTML = ICON;
    b.addEventListener("click", () => chrome.runtime.sendMessage({ type: "openHub" }));
    const wrap = document.createElement("div");
    wrap.className = `tbc-hubbtn-wrap ${extra}-wrap`;
    wrap.append(b);
    return wrap;
  }

  function place() {
    // Top bar, right of the search box.
    const search = document.querySelector(".top-nav__search-container");
    if (search && !search.nextElementSibling?.classList.contains("tbc-hubtop-wrap")) {
      document.querySelector(".tbc-hubtop-wrap")?.remove();
      search.after(button("tbc-hubtop"));
    }
    // Every chat header on the page (the stream's chat, pop-out chat).
    for (const header of document.querySelectorAll(".stream-chat-header")) {
      if (header.querySelector(".tbc-hubchat")) continue;
      const users = header.querySelector('button[aria-label="Users in Chat"]') || [...header.querySelectorAll("button")].pop();
      if (users) users.parentElement.before(button("tbc-hubchat"));
    }
  }

  // Twitch rebuilds the chat header as you go.
  place();
  tbcWatch(place, 500);
});

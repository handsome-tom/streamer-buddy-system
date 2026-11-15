// The hub: the StreamSpace button in Twitch's top bar (just right of your
// profile picture), and a smaller, quieter one in the chat header (just left of Twitch's
// "Users in Chat" community button). Either opens Streamer Buddy System, the separate hub project
// (github.com/handsome-tom/streamer-buddy-system), in Chrome's side panel
// (hub.html), like Claude's extension. That's where you and the streamer (and
// anyone else you've connected with) ask each other quick questions, see who's
// online, and see what's been answered and seen.
//
// Wrapped so its names don't clash with the other scripts, and only started if
// it's switched on (settings.js).
whenOn("hub", "Streamer Buddy System (StreamSpace button)", () => {
  if ((window.top !== window && !window.TWITCH_ME)) return;

  // The StreamSpace mark (the speech bubble and the people from Alex's logo), in white.
  const ICON = '<svg width="20" height="20" viewBox="70 45 760 760" fill="currentColor" aria-hidden="true"><path d="M125,50l-50,125v475h150v100h100l100-100h125l175-175V50H125ZM650,450l-100,100h-150l-100,100v-100h-125V125h475v325Z"/><path d="M429.87,215.86c0-28.14,23-50.96,51.36-50.96s51.36,22.81,51.36,50.96-23,50.97-51.36,50.97-51.36-22.82-51.36-50.97ZM481.22,279.02c-18.07,0-34.54,6.62-47.21,17.5-7.41-20.96-27.47-36.01-51.13-36.01-14.51,0-27.66,5.69-37.38,14.9-4.9-15.1-19.16-26.04-36.02-26.04-20.89,0-37.83,16.8-37.83,37.54h-.12v65.06h56.98v55.55h80.24v67.42h144.73v-124.23c0-39.59-32.35-71.69-72.25-71.69ZM382.89,251.36c21.29,0,38.54-17.12,38.54-38.25s-17.25-38.24-38.54-38.24-38.53,17.12-38.53,38.24c0,21.13,17.26,38.25,38.53,38.25ZM309.49,242.98c14.85,0,26.9-11.94,26.9-26.69s-12.04-26.69-26.9-26.69-26.89,11.94-26.89,26.69c0,14.74,12.04,26.69,26.89,26.69Z"/></svg>';

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
    // Top bar: just right of your profile picture (signed out: right of the search box).
    const me = document.querySelector('[data-a-target="user-menu-toggle"]');
    const spot = me?.closest(".top-nav__menu > div:last-child > *") || document.querySelector(".top-nav__search-container");
    if (spot && !spot.nextElementSibling?.classList.contains("tbc-hubtop-wrap")) {
      document.querySelector(".tbc-hubtop-wrap")?.remove();
      spot.after(button("tbc-hubtop"));
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

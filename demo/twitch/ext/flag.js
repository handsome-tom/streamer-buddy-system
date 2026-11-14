// Flagging chat for the streamer: point at a line of Twitch chat and a small
// flag appears. Click it and the line goes to the streamer's quick strip in
// Streamer Buddy System (with who said it and who flagged it, for 5 minutes),
// and it glows in the chat of everyone connected with that streamer who's
// watching, in the colour of whoever flagged it. Only people with StreamSpace
// see the glow: it can't change Twitch's chat for anyone else.
//
// The flag only appears in the chat of a channel you and its streamer have both
// connected with in Streamer Buddy System (or your own channel), not on every
// stream you watch. background.js keeps the connection to the relay, using the
// sign-in the hub handed over, so the handshake has to have been signed in once.
//
// Wrapped so its names don't clash with the other scripts, and only started if
// it's switched on (settings.js).
whenOn("flag", "Flag chat lines to the streamer", () => {
  if ((window.top !== window && !window.TWITCH_ME)) return;

  const LINE = ".chat-line__message";
  const GLOW_MS = 5 * 60 * 1000;
  const FLAG_ICON = '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 18V3M5 4h10l-2.5 3.5L15 11H5"/></svg>';

  // The channel whose chat this is.
  function channelName() {
    const parts = location.pathname.split("/").filter(Boolean);
    const name = (parts[0] === "popout" || parts[0] === "moderator" ? parts[1] : parts[0])?.toLowerCase();
    return name && /^[a-z0-9_]+$/.test(name) ? name : null;
  }

  // A line's words, with emotes as their names.
  function lineText(line) {
    const parts = [...line.querySelectorAll('[data-a-target="chat-line-message-body"]')];
    let text = "";
    for (const part of parts) {
      const walk = (node) => {
        if (node.nodeType === 3) text += node.textContent;
        else if (node.tagName === "IMG") text += node.alt || "";
        else node.childNodes.forEach(walk);
      };
      walk(part);
    }
    return text.replace(/\s+/g, " ").trim();
  }

  // Someone's chat colour and picture from Twitch (public, no sign-in needed),
  // looked up once per person.
  const people = new Map();
  function person(login) {
    if (!people.has(login)) {
      people.set(
        login,
        fetch("https://gql.twitch.tv/gql", {
          method: "POST",
          headers: { "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko" },
          body: JSON.stringify({ query: "query($l:String!){ user(login:$l){ chatColor profileImageURL(width:50) } }", variables: { l: login } }),
        })
          .then((r) => r.json())
          .then((j) => j.data?.user || {})
          .catch(() => ({}))
      );
    }
    return people.get(login);
  }

  // You, from Twitch's "login" cookie.
  const myLogin = document.cookie.match(/(?:^|; )login=([^;]+)/)?.[1];
  const me = myLogin ? person(decodeURIComponent(myLogin)) : Promise.resolve({});

  // A line's emotes, { name: picture }, so a copy of it can show them.
  function lineEmotes(line) {
    const emotes = {};
    for (const img of line.querySelectorAll('[data-a-target="chat-line-message-body"] img')) {
      if (img.alt && img.src) emotes[img.alt] = img.src;
    }
    return emotes;
  }

  // A line's name as shown and its colour as #rrggbb.
  function lineName(line) {
    const name = line.querySelector('[data-a-target="chat-message-username"]');
    if (!name) return {};
    const rgb = getComputedStyle(name).color.match(/\d+/g) || [];
    const color = rgb.length >= 3 ? `#${rgb.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}` : undefined;
    return { chatterName: name.textContent.trim(), chatterColor: color };
  }

  function unglow(line) {
    clearTimeout(line.tbcFlagTimer);
    line.classList.remove("tbc-flagged");
    line.title = "";
    delete line.dataset.tbcFlag;
    line.querySelector(".tbc-flagpic")?.remove();
    line.querySelector(".tbc-flagx")?.remove();
  }

  function glow(line, color, who, id) {
    unglow(line);
    line.dataset.tbcFlag = id;
    line.classList.add("tbc-flagged");
    line.style.setProperty("--tbc-flag", color || "#ffb31a");
    line.title = `Flagged by ${who}`;
    person(who).then((p) => {
      line.querySelector(".tbc-flagpic")?.remove();
      if (!p.profileImageURL || !line.classList.contains("tbc-flagged")) return;
      const pic = document.createElement("img");
      pic.className = "tbc-flagpic";
      pic.src = p.profileImageURL;
      pic.alt = "";
      line.append(pic);
    });
    // Pointing at the line swaps the picture for an X that clears it for everyone.
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "tbc-flagx";
    clear.title = "Clear this flag for everyone";
    clear.setAttribute("aria-label", "Clear this flag for everyone");
    clear.textContent = "×";
    clear.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      port?.postMessage({ t: "unflag", id });
      unglow(line);
    });
    line.append(clear);
    line.tbcFlagTimer = setTimeout(() => unglow(line), GLOW_MS);
  }

  function toast(text) {
    document.querySelector(".tbc-flagtoast")?.remove();
    const t = document.createElement("div");
    t.className = "tbc-flagtoast";
    t.textContent = text;
    document.body.append(t);
    setTimeout(() => t.remove(), 4000);
  }

  // Can you flag here? Your own channel, or one you're connected with both ways.
  let circle = { me: null, mutual: [] };
  function canFlag() {
    const channel = channelName();
    return !!channel && !!circle.me && (channel === circle.me || circle.mutual.includes(channel));
  }

  // Elsewhere there's no flag, and no strip left of each line to make room for it.
  function showFlagging() {
    const can = canFlag();
    document.documentElement.classList.toggle("tbc-flagging", can);
    if (!can) button.remove();
    return can;
  }

  // ===== The relay, through background.js ====================================================

  let port = null;
  function connect() {
    try {
      port = chrome.runtime.connect({ name: "hub" });
    } catch {
      return; // the extension was reloaded under this page
    }
    port.onMessage.addListener(heard);
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 1000);
    });
  }

  function heard(m) {
    if (m.t === "people") {
      circle = { me: m.me, mutual: m.mutual };
      showFlagging();
    } else if (m.t === "flash" && m.f.kind === "chat" && m.f.channel === channelName()) {
      const lines = [...document.querySelectorAll(LINE)].reverse();
      const line = lines.find((l) => l.dataset.aUser === m.f.chatter && lineText(l) === m.f.text);
      if (line) glow(line, m.f.color, m.f.from, m.f.id);
    } else if (m.t === "unflash") {
      const line = document.querySelector(`[data-tbc-flag="${CSS.escape(m.id)}"]`);
      if (line) unglow(line);
    } else if (m.t === "flashed" && m.kind === "chat") {
      toast(m.reached ? `Sent to ${m.to}` : `${m.to}'s panel isn't open, so only the chat glow went out`);
    } else if (m.t === "needSignin") {
      toast("Click the handshake and sign in first, then flag again");
    } else if (m.t === "error") {
      toast(m.why);
    }
  }

  // ===== The flag button =====================================================================

  const button = document.createElement("button");
  button.type = "button";
  button.className = "tbc-flagbtn";
  button.title = "Flag this for the streamer";
  button.setAttribute("aria-label", "Flag this for the streamer");
  button.innerHTML = FLAG_ICON;
  button.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const line = button.closest(LINE);
    const channel = channelName();
    const chatter = line?.dataset.aUser;
    const text = line && lineText(line);
    if (!channel || !chatter || !text) return;
    const { chatColor } = await me;
    if (!port) return toast("Refresh Twitch and try again");
    port.postMessage({ t: "flag", channel, chatter, text, color: chatColor, emotes: lineEmotes(line), ...lineName(line) });
  });
  me.then((p) => {
    if (p.chatColor) button.style.color = p.chatColor;
  });

  document.addEventListener("mouseover", (e) => {
    const line = e.target.closest?.(LINE);
    if (!line) return;
    if (showFlagging() && button.parentElement !== line) line.append(button);
  });
  setInterval(showFlagging, 1000); // Twitch changes channel without loading a new page

  connect();
});

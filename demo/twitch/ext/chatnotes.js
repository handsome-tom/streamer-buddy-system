// Chat notes: a note on one line of any channel's chat, for the people you're connected with.
//
// Move toward the right of a line of chat, where Twitch's reply and three-dot buttons
// are, and after a moment a small dot with a speech bubble appears just left of them.
// Click it and a box opens above the line; Enter sends. The note slides up into a bubble above that line, with your
// picture and name, for everyone you're connected with both ways, on any channel's
// regular chat. When you're in that streamer's circle (it's your channel, or you and they
// are connected both ways), they and their connections see it too, in their chat dock.
// Nobody else sees it.
//
// The same works on a VOD's chat replay, for a note on something in the past: it's
// kept against that comment's moment, as if it had been written live.
//
// Notes belong to their moment in the stream. The relay keeps each one against when
// it was written (and drops it after 60 days, about as long as Twitch keeps a VOD).
// Watching that broadcast's VOD back, the note comes back on the same comment as chat
// replay reaches it. There's no list of notes anywhere: only the bubbles on their lines.
//
// A note finds its line by who said it and what they said. On a VOD the comment's time
// has to fit too (written up to 15 minutes after it), so a repeated message picks the
// right one. You can take back your own note with the × on it.
//
// Wrapped so its names don't clash with the other scripts, and only started if
// it's switched on (settings.js).
whenOn("chatnotes", "Notes on chat lines for mods", () => {
  if ((window.top !== window && !window.TWITCH_ME)) return;

  const LIVE_LINE = ".chat-line__message";
  const VOD_LINE = ".vod-message";
  const HOVER_MS = 500; // that long near a line's right side before the dot shows
  const NEAR_RIGHT = 0.55; // how far across a line counts as heading for its right side
  const LIVE_LOOKBACK_MS = 12 * 60 * 60 * 1000; // notes asked for on opening a live channel
  const VOD_BEFORE_S = 15 * 60; // a note can be written this long after its comment
  const VOD_AFTER_S = 60; // ... or seem a little before it (the stream's delay)
  const MAX_BODY = 300;
  const BUBBLE_ICON = '<svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h12a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 14h-6l-4 3v-3H4a1.5 1.5 0 0 1-1.5-1.5v-7A1.5 1.5 0 0 1 4 4z"/></svg>';
  const SEND_ICON = '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10l14-6-5 14-2.5-6L3 10z"/></svg>';

  // ===== Where we are =========================================================================

  const vodId = () => location.pathname.match(/^\/videos\/(\d+)/)?.[1] || null;

  // The live channel whose chat this is (null on a VOD).
  function liveChannel() {
    if (vodId()) return null;
    const parts = location.pathname.split("/").filter(Boolean);
    const name = (parts[0] === "popout" || parts[0] === "moderator" ? parts[1] : parts[0])?.toLowerCase();
    return name && /^[a-z0-9_]+$/.test(name) && name !== "directory" && name !== "videos" ? name : null;
  }

  // The VOD being watched: { id, channel, start } once Twitch has said.
  let vod = null;
  let vodAsking = null;
  function loadVod() {
    const id = vodId();
    if (!id) return (vod = null);
    if (vod?.id === id || vodAsking === id) return;
    vodAsking = id;
    vod = null;
    tbcLookup("video", { id })
      .then((j) => {
        if (vodId() !== id) return;
        const v = j?.data;
        if (v?.start && v.channel) {
          vod = { id, channel: v.channel.toLowerCase(), start: v.start };
          askNotes();
        }
      })
      .catch(() => {})
      .finally(() => {
        if (vodAsking === id) vodAsking = null;
      });
  }

  const channel = () => liveChannel() || vod?.channel || null;

  // Notes work on any channel once you're signed in to Streamer Buddy System; the relay
  // decides who sees each one.
  let circle = { me: null, mutual: [] };
  function canNote() {
    return !!channel() && !!circle.me;
  }

  // ===== People ===============================================================================

  // Someone's picture and chat colour from Twitch (public), looked up once each.
  const people = new Map();
  function person(login) {
    if (!people.has(login)) {
      people.set(
        login,
        fetch("https://gql.twitch.tv/gql", {
          method: "POST",
          headers: { "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko" },
          body: JSON.stringify({ query: "query($l:String!){ user(login:$l){ displayName chatColor profileImageURL(width:50) } }", variables: { l: login } }),
        })
          .then((r) => r.json())
          .then((j) => j.data?.user || {})
          .catch(() => ({}))
      );
    }
    return people.get(login);
  }
  const myLogin = decodeURIComponent(document.cookie.match(/(?:^|; )login=([^;]+)/)?.[1] || "");
  let myColor; // your chat colour, looked up ahead so sending never waits
  if (myLogin) person(myLogin).then((p) => (myColor = p.chatColor));

  // ===== Lines ================================================================================

  const lineSel = () => (vodId() ? VOD_LINE : LIVE_LINE);

  function lineChatter(line) {
    return line.querySelector('[data-a-target="chat-message-username"]')?.dataset.aUser?.toLowerCase() || null;
  }

  function lineName(line) {
    return line.querySelector('[data-a-target="chat-message-username"]')?.textContent.trim() || "";
  }

  // A line's words, with emotes as their names (the same on a live line and its VOD comment).
  function lineText(line) {
    const parts = vodId()
      ? [...line.querySelectorAll(".video-chat__message")]
      : [...line.querySelectorAll('[data-a-target="chat-line-message-body"]')];
    let text = "";
    const walk = (node) => {
      if (node.nodeType === 3) text += node.textContent;
      else if (node.tagName === "IMG") text += node.alt || "";
      else if (!node.classList?.contains("tbc-notes")) node.childNodes.forEach(walk);
    };
    parts.forEach(walk);
    if (vodId()) text = text.replace(/^\s*:\s*/, ""); // the ": " after the name
    return text.replace(/\s+/g, " ").trim();
  }

  // A VOD comment's time in the video, in seconds, from its "1:00:16".
  function lineTime(line) {
    const m = line.querySelector(".vod-message__header")?.textContent.match(/(?:(\d+):)?(\d+):(\d\d)/);
    return m ? (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] : null;
  }

  // Where a line's bubbles go: inside it on live chat, in its row on a VOD (the
  // comment itself is laid out in columns).
  const hostOf = (line) => (vodId() ? line.closest("li") || line : line);

  function lineOf(el) {
    return el.closest?.(lineSel()) || null;
  }

  // ===== Notes ================================================================================

  let notes = []; // this channel's (or this VOD's) notes, oldest first
  let notesFor = null; // what they're for: "live:<channel>" or "vod:<id>"

  // The lines on screen by who said what: "chatter\ntext" -> [lines], oldest first.
  function lineIndex() {
    const index = new Map();
    for (const l of document.querySelectorAll(lineSel())) {
      const key = `${lineChatter(l)}\n${lineText(l)}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(l);
    }
    return index;
  }

  // The best line on screen for a note, or null.
  function bestLine(n, index = lineIndex()) {
    const lines = index.get(`${n.chatter}\n${n.text}`) || [];
    if (!lines.length) return null;
    if (!vodId()) return lines[lines.length - 1]; // the newest one
    if (!vod) return null;
    const at = (n.at - vod.start) / 1000;
    let best = null;
    let gap = Infinity;
    for (const l of lines) {
      const t = lineTime(l);
      if (t == null || t > at + VOD_AFTER_S || t < at - VOD_BEFORE_S) continue;
      if (Math.abs(at - t) < gap) [best, gap] = [l, Math.abs(at - t)];
    }
    return best;
  }

  function bubble(n) {
    const b = document.createElement("div");
    b.className = "tbc-note";
    b.dataset.tbcNote = n.id;
    const pic = document.createElement("span");
    pic.className = "tbc-note__pic";
    pic.textContent = (n.from[0] || "?").toUpperCase();
    // An iPhone-style text bubble: the writer's picture and name inside it at the top,
    // the note, and the time tucked in the bottom corner. Someone else's sits on the left
    // with its tail bottom-left; yours on the right in brighter blue, tail bottom-right.
    const mine = n.from === circle.me;
    if (mine) b.classList.add("tbc-note--mine");
    const main = document.createElement("div");
    main.className = "tbc-note__main";
    const name = document.createElement("b");
    name.className = "tbc-note__who";
    name.textContent = n.from;
    const body = document.createElement("span");
    body.className = "tbc-note__body";
    body.textContent = n.body;
    const when = document.createElement("span");
    when.className = "tbc-note__when";
    when.textContent = new Date(n.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    when.title = new Date(n.at).toLocaleString();
    if (mine) name.textContent = "You";
    const head = document.createElement("span");
    head.className = "tbc-note__head";
    head.append(pic, name);
    main.append(head, body, when);
    b.append(main);
    if (mine) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "tbc-note__x";
      x.title = "Take back this note";
      x.setAttribute("aria-label", "Take back this note");
      x.textContent = "×";
      x.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        send({ t: "unnote", id: n.id, channel: n.channel, at: n.at });
      });
      b.append(x);
    }
    person(n.from).then((p) => {
      if (p.displayName && !mine) name.textContent = p.displayName;
      if (!p.profileImageURL) return;
      const img = document.createElement("img");
      img.className = "tbc-note__pic";
      img.src = p.profileImageURL;
      img.alt = "";
      pic.replaceWith(img);
    });
    return b;
  }

  // The box of bubbles above a line (made if asked).
  function stackOf(line, make) {
    const host = hostOf(line);
    let stack = host.querySelector(":scope > .tbc-notes");
    if (!stack && make) {
      stack = document.createElement("div");
      stack.className = "tbc-notes";
      host.prepend(stack);
      host.classList.add("tbc-noted"); // the comment it's about, lit faintly
    }
    return stack;
  }

  // Put a note on its line (moving it if a better one turned up), if it's on screen.
  function place(n, fresh, index) {
    const line = bestLine(n, index);
    const old = document.querySelector(`[data-tbc-note="${CSS.escape(n.id)}"]`);
    if (!line) return;
    if (old && hostOf(line).contains(old)) return;
    if (old) unstack(old);
    const b = bubble(n);
    if (fresh) b.classList.add("tbc-note--new");
    const stack = stackOf(line, true);
    const box = stack.querySelector(".tbc-notebox");
    stack.insertBefore(b, box || null);
  }

  function unstack(b) {
    const stack = b.parentElement;
    b.remove();
    if (stack && !stack.childElementCount) {
      stack.parentElement?.classList.remove("tbc-noted");
      stack.remove();
    }
  }

  function placeAll() {
    if (!notes.length || !canNote()) return;
    const index = lineIndex();
    for (const n of notes) place(n, false, index);
  }

  function vodEnd() {
    const len = document.querySelector("video")?.duration;
    return vod.start + (isFinite(len) && len > 0 ? len * 1000 + 60000 : 48 * 60 * 60 * 1000);
  }

  function askNotes() {
    if (!canNote()) return;
    const v = vodId();
    if (v) {
      if (!vod || notesFor === `vod:${v}`) return;
      notesFor = `vod:${v}`;
      notes = [];
      send({ t: "notes", channel: vod.channel, from: vod.start, to: vodEnd() });
    } else {
      const c = liveChannel();
      if (!c || notesFor === `live:${c}`) return;
      notesFor = `live:${c}`;
      notes = [];
      send({ t: "notes", channel: c, from: Date.now() - LIVE_LOOKBACK_MS, to: Date.now() });
    }
  }

  // ===== The relay, through background.js =====================================================

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

  function send(m) {
    if (!port) return toast("Refresh Twitch and try again");
    port.postMessage(m);
  }

  function heard(m) {
    if (m.t === "people") {
      circle = { me: m.me, mutual: m.mutual };
      tick();
    } else if (m.t === "notes") {
      const want = vodId() ? vod && `vod:${vod.id}` : `live:${liveChannel()}`;
      if (m.channel !== channel() || notesFor !== want) return;
      const known = new Set(notes.map((n) => n.id));
      notes = [...notes, ...m.list.filter((n) => !known.has(n.id))].sort((a, b) => a.at - b.at);
      placeAll();
    } else if (m.t === "note") {
      const n = m.n;
      if (notes.some((x) => x.id === n.id)) return;
      // Live: this channel's. A VOD: this broadcast's (someone noting a comment on it).
      const mine = vodId() ? vod && notesFor === `vod:${vod.id}` && n.channel === vod.channel && n.at >= vod.start && n.at <= vodEnd() : n.channel === liveChannel();
      if (!mine) return;
      notes.push(n);
      place(n, true);
    } else if (m.t === "unnote") {
      notes = notes.filter((n) => n.id !== m.id);
      const b = document.querySelector(`[data-tbc-note="${CSS.escape(m.id)}"]`);
      if (b) unstack(b);
    } else if (m.t === "needSignin") {
      toast("Click the handshake and sign in first");
    }
  }

  function toast(text) {
    document.querySelector(".tbc-flagtoast")?.remove();
    const t = document.createElement("div");
    t.className = "tbc-flagtoast";
    t.textContent = text;
    document.body.append(t);
    setTimeout(() => t.remove(), 4000);
  }

  // ===== The dot and the box ==================================================================

  const dot = document.createElement("button");
  dot.type = "button";
  dot.className = "tbc-notedot";
  dot.title = "Note this for the mods";
  dot.setAttribute("aria-label", "Note this for the mods");
  dot.innerHTML = BUBBLE_ICON;

  let hoverLine = null;
  let hoverTimer = 0;
  let dotLine = null;

  // Twitch's own buttons on a line (reply, and the three dots): live chat keeps them in a
  // little box at the line's top-right; VOD chat has its three dots on the right.
  const twitchButtons = (line) => line.querySelector(".chat-line__icons, .video-chat__message-menu");

  // The dot goes inside the line, just left of Twitch's buttons, so the line stays
  // "hovered" (and Twitch's buttons stay showing) while you move onto it.
  function showDot(line) {
    const r = line.getBoundingClientRect();
    const b = twitchButtons(line)?.getBoundingClientRect();
    const has = b && b.width > 0 && b.top < r.bottom && b.bottom > r.top;
    const right = has ? b.left : r.right - 8;
    const mid = has ? b.top + b.height / 2 : r.top + Math.min(r.height, 32) / 2;
    line.classList.add("tbc-notehost");
    dot.style.left = `${right - r.left - 28}px`;
    dot.style.top = `${mid - r.top - 12}px`;
    if (dot.parentElement !== line) line.append(dot);
    dotLine = line;
    dot.classList.remove("tbc-notedot--quick");
    void dot.offsetWidth; // placed first, so it pops in rather than sliding over
    dot.classList.add("tbc-notedot--on");
  }

  function hideDot(quick) {
    clearTimeout(hoverTimer);
    dot.classList.toggle("tbc-notedot--quick", !!quick);
    dot.classList.remove("tbc-notedot--on");
    dotLine?.classList.remove("tbc-notehost");
    dotLine = null;
    hoverLine = null;
  }

  // It shows once the pointer heads for the right side of a line, where Twitch's buttons
  // are, after a moment there; back to the left (or off the line) it goes.
  let pointer = { x: -1, y: -1 };
  document.addEventListener("mousemove", (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    if (e.target === dot || dot.contains(e.target)) return clearTimeout(hoverTimer);
    const line = e.target.closest?.(lineSel()) || null;
    const ok = line && canNote() && !e.target.closest(".tbc-notes");
    const r = ok && line.getBoundingClientRect();
    const near = ok && e.clientX >= r.left + r.width * NEAR_RIGHT;
    if (!near) {
      if (dotLine || hoverLine) hideDot();
      return;
    }
    if (line === dotLine || line === hoverLine) return;
    hideDot();
    hoverLine = line;
    hoverTimer = setTimeout(() => hoverLine === line && line.isConnected && showDot(line), HOVER_MS);
  }, { passive: true });
  // New chat moving lines along: the dot rides with its line while the pointer is still
  // on it; once the line has moved out from under the pointer, it goes at once. A line
  // sliding under a still pointer gets nothing until the mouse moves.
  function stillUnder() {
    if (!dotLine && !hoverLine) return;
    const el = document.elementFromPoint(pointer.x, pointer.y);
    const line = el?.closest?.(lineSel());
    if (el !== dot && !dot.contains(el) && line !== (dotLine || hoverLine)) hideDot(true);
  }
  document.addEventListener("scroll", stillUnder, { capture: true, passive: true });
  tbcWatch(stillUnder, 100);

  dot.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (dotLine) openBox(dotLine);
    hideDot();
  });

  function openBox(line) {
    document.querySelector(".tbc-notebox")?.closest(".tbc-notes") && closeBox();
    const chatter = lineChatter(line);
    const text = lineText(line);
    const c = channel();
    // On a VOD, the note belongs to the comment's moment in the stream.
    const t = vodId() ? lineTime(line) : null;
    if (!chatter || !text || !c || (vodId() && (!vod || t == null))) return;
    const at = vodId() ? vod.start + t * 1000 : undefined;
    const stack = stackOf(line, true);
    const box = document.createElement("form");
    box.className = "tbc-notebox";
    const input = document.createElement("textarea");
    input.rows = 1;
    input.maxLength = MAX_BODY;
    input.placeholder = `Note about ${lineName(line) || chatter}'s message`;
    const go = document.createElement("button");
    go.type = "submit";
    go.className = "tbc-notebox__send";
    go.title = "Send to the mods";
    go.setAttribute("aria-label", "Send to the mods");
    go.innerHTML = SEND_ICON;
    box.append(input, go);
    stack.append(box);
    input.focus();
    const grow = () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 90)}px`;
    };
    input.addEventListener("input", grow);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // keep Twitch's own shortcuts out of it
      if (e.key === "Escape") closeBox();
      else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        box.requestSubmit();
      }
    });
    box.addEventListener("submit", (e) => {
      e.preventDefault();
      const body = input.value.replace(/\s+/g, " ").trim();
      if (!body) return input.focus();
      send({ t: "note", channel: c, chatter, chatterName: lineName(line), text, body, color: myColor, at });
      closeBox();
    });
  }

  function closeBox() {
    const box = document.querySelector(".tbc-notebox");
    if (box) unstack(box);
  }

  document.addEventListener("mousedown", (e) => {
    const box = document.querySelector(".tbc-notebox");
    if (box && !box.contains(e.target) && !box.querySelector("textarea").value.trim()) closeBox();
  });

  // ===== Keeping up ===========================================================================

  let lastPlace = location.pathname;
  function tick() {
    if (location.pathname !== lastPlace) {
      lastPlace = location.pathname;
      notes = [];
      notesFor = null;
      closeBox();
      hideDot();
      document.querySelectorAll(".tbc-notes").forEach((s) => (s.parentElement?.classList.remove("tbc-noted"), s.remove()));
    }
    loadVod();
    if (!canNote()) return hideDot();
    askNotes();
  }

  tbcWatch(placeAll, 300); // new lines, and chat replay as the VOD plays
  setInterval(tick, 1000); // Twitch changes page without loading a new one
  connect();
  tick();
});

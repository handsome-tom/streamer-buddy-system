// The pretend Twitch chat (chat.html): the demo's chat, drawn the way Twitch draws its own,
// so StreamSpace's chat scripts find the same pieces they find on twitch.tv. Messages and
// notices come from the pretend Twitch (demo/hub.js) the same way they reach the streamer's
// dock; typing here and pressing Enter (or Chat) says it in chat as the mod.
(() => {
  const lines = document.getElementById("lines");
  const paused = document.getElementById("paused");
  const input = document.querySelector('[data-a-target="chat-input"]');
  const ME = window.TWITCH_ME;
  const SHOWN = window.TWITCH_SHOWN;
  const MAX_LINES = 150;
  window.TWITCH_COLORS = {}; // login -> chat color, as the chat shows it (shim.js uses it too)
  const sandbox = () => window.parent !== window && window.parent.SANDBOX;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // ----- Badges: the pretend Twitch's pictures for each badge -------------------------------------
  const badgeArt = new Map(); // "set/id" -> { url, title }
  async function loadBadges(box) {
    try {
      const r = await box.fetch(`${location.origin}/mock/helix/chat/badges/global`);
      for (const set of (await r.json()).data || []) for (const v of set.versions || []) badgeArt.set(`${set.set_id}/${v.id}`, { url: v.image_url_1x, title: v.title });
    } catch {}
  }

  // ----- Scrolling: stick to the bottom unless you've scrolled up, like Twitch ---------------------
  let stuck = true;
  const atBottom = () => lines.scrollHeight - lines.scrollTop - lines.clientHeight < 30;
  lines.addEventListener("scroll", () => {
    stuck = atBottom();
    paused.hidden = stuck;
  });
  paused.addEventListener("click", () => {
    lines.scrollTop = lines.scrollHeight;
    stuck = true;
    paused.hidden = true;
  });
  function add(node) {
    lines.append(node);
    while (lines.childElementCount > MAX_LINES) lines.firstElementChild.remove();
    if (stuck) lines.scrollTop = lines.scrollHeight;
  }

  // ----- A chat line, built like Twitch's ------------------------------------------------------------
  const iconBtn = (label, path) => {
    const b = el("button", "tw-iconbtn tw-iconbtn--small");
    b.type = "button";
    b.title = b.ariaLabel = label;
    b.innerHTML = `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="${path}" fill="currentColor"/></svg>`;
    return b;
  };
  function body(e) {
    const wrap = el("span");
    wrap.dataset.aTarget = "chat-line-message-body";
    for (const f of e.message?.fragments || [{ type: "text", text: e.message?.text || "" }]) {
      if (f.type === "emote" && f.emote?.id) {
        const img = el("img", "chat-line__message--emote");
        img.alt = f.text;
        img.src = `https://static-cdn.jtvnw.net/emoticons/v2/${f.emote.id}/default/dark/1.0`;
        wrap.append(img);
      } else if (f.type === "mention") {
        wrap.append(el("span", "mention-fragment", f.text));
      } else {
        const t = el("span", "text-fragment", f.text);
        t.dataset.aTarget = "chat-message-text";
        wrap.append(t);
      }
    }
    return wrap;
  }
  function messageLine(e) {
    const login = String(e.chatter_user_login || "").toLowerCase();
    const shown = SHOWN[login] || e.chatter_user_name || login;
    const color = e.color || window.TWITCH_COLORS[login] || "#a970ff";
    window.TWITCH_COLORS[login] = color;
    const line = el("div", "chat-line__message");
    line.dataset.aTarget = "chat-line-message";
    line.dataset.aUser = login;
    line.dataset.msgId = e.message_id || "";
    line.tabIndex = 0;
    const box = el("div", "chat-line__message-container");
    const who = el("span", "chat-line__username-container");
    for (const b of e.badges || []) {
      const art = badgeArt.get(`${b.set_id}/${b.id}`);
      if (!art?.url) continue;
      const img = el("img", "chat-badge");
      img.src = art.url;
      img.alt = img.title = art.title || b.set_id;
      who.append(img);
    }
    const name = el("span", "chat-line__username");
    const author = el("span", "chat-author__display-name", shown);
    author.dataset.aTarget = "chat-message-username";
    author.dataset.aUser = login;
    author.style.color = color;
    name.append(author);
    who.append(name);
    box.append(who, el("span", "tw-colon", ": "), body(e));
    // Twitch's own buttons on a line: reply, and the three dots (shown on hover).
    const icons = el("div", "chat-line__icons");
    icons.append(iconBtn("Click to reply", "M8.5 5.5L7 4 2 9l5 5 1.5-1.5L6 10h4a4 4 0 0 1 4 4v2h2v-2a6 6 0 0 0-6-6H6l2.5-2.5z"), iconBtn("More message options", "M10 18a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0-6a2 2 0 1 1 0-4 2 2 0 0 1 0 4zM8 4a2 2 0 1 0 4 0 2 2 0 0 0-4 0z"));
    line.append(box, icons);
    return line;
  }
  // Raids, subs, gifts, announcements: Twitch's notice lines (StreamSpace leaves these alone).
  function noticeLine(e) {
    const line = el("div", "user-notice-line");
    const kind = String(e.notice_type || "").replace(/^shared_chat_/, "");
    line.dataset.kind = kind;
    const say = e.system_message || (kind === "announcement" ? "Announcement" : kind);
    line.append(el("div", "tw-notice__head", say));
    if (e.message?.text) {
      const msg = el("div", "tw-notice__msg");
      const login = String(e.chatter_user_login || "").toLowerCase();
      const author = el("span", "chat-author__display-name", SHOWN[login] || e.chatter_user_name || login);
      author.style.color = e.color || "#a970ff";
      msg.append(author, el("span", "tw-colon", ": "), body(e));
      line.append(msg);
    }
    return line;
  }
  // Messages a mod removed: Twitch shows "<message deleted>" to mods.
  function deleted(id) {
    const line = lines.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
    const b = line?.querySelector('[data-a-target="chat-line-message-body"]');
    if (b) b.replaceChildren(el("span", "tw-deleted", "<message deleted>"));
  }
  function clearedUser(login) {
    for (const line of lines.querySelectorAll(`.chat-line__message[data-a-user="${CSS.escape(login)}"]`)) {
      line.querySelector('[data-a-target="chat-line-message-body"]')?.replaceChildren(el("span", "tw-deleted", "<message deleted>"));
    }
  }

  // ----- The pretend Twitch's chat feed -----------------------------------------------------------------
  async function start() {
    let box = sandbox();
    while (!box) {
      await new Promise((r) => setTimeout(r, 100));
      box = sandbox();
    }
    await loadBadges(box);
    add(el("div", "tw-welcome", "Welcome to the chat room!"));
    const ws = new box.Socket("wss://sandbox.invalid/mock/ws");
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.metadata?.message_type !== "notification") return;
      const type = m.payload?.subscription?.type;
      const e = m.payload?.event || {};
      if (type === "channel.chat.message") add(messageLine(e));
      else if (type === "channel.chat.notification") add(noticeLine(e));
      else if (type === "channel.chat.message_delete") deleted(e.message_id);
      else if (type === "channel.chat.clear_user_messages") clearedUser(String(e.target_user_login || "").toLowerCase());
      else if (type === "channel.chat.clear") lines.replaceChildren(el("div", "tw-welcome", "Chat was cleared by a moderator"));
    };
    ws.onclose = () => setTimeout(start, 2000);
  }
  start();

  // ----- Saying something, as the mod ---------------------------------------------------------------
  function send() {
    const text = input.textContent.replace(/﻿/g, "").replace(/\s+/g, " ").trim();
    if (!text) return;
    sandbox()?.say?.(ME.login, text);
    input.textContent = "";
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  // A paste (StreamSpace's quick phrases hand text over as one) goes in as plain text.
  input.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text/plain");
    if (text == null) return;
    e.preventDefault();
    document.execCommand("insertText", false, text);
  });
  document.getElementById("send").addEventListener("click", send);
})();

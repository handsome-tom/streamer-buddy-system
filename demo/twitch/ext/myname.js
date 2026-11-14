// Your name stands out in chat. A box in your own chat-name colour goes around
// your username on your own messages, and wherever someone else writes your
// username, with an @ or without. Twitch already styles some @mentions of you
// itself; those are left exactly as Twitch draws them.
//
// Who you are comes from Twitch's "login" cookie; your chat colour from Twitch
// (public, no sign-in needed), kept on the page as --tbc-me-color. The colour is
// saved as "myChatColor" so the box has it straight away on the next page load.
//
// New chat lines are boxed the moment they're added, before the browser draws
// them, so the text doesn't shift when the box appears.
//
// Highlight words: other words to box the same way, whole words, any
// capitalisation. Added and removed in the quick phrases pop-up (phrases.js),
// under the phrases. Saved in chrome.storage.local as "highlightWords": [words].
// New words apply to messages from then on.
//
// Wrapped so its names don't clash with the other scripts, and only started if
// it's switched on (settings.js).
whenOn("myname", "Your name boxed in chat", () => {
  const LINE = '[data-a-target="chat-line-message"], .vod-message';
  const USERNAME = '[data-a-target="chat-message-username"]';
  const TEXT = '[data-a-target="chat-message-text"], .text-fragment';
  const MENTION = ".mention-fragment";
  const TWITCH_MENTION = '.mention-fragment--recipient, [class*="mention-fragment--"]';

  const cookie = (k) => {
    const m = document.cookie.match(new RegExp(`(?:^|; )${k}=([^;]+)`));
    try {
      return m ? decodeURIComponent(m[1]) : "";
    } catch {
      return "";
    }
  };

  let names = [];
  let words = [];
  let pattern = null;
  let patternKey = "";

  function readNames() {
    const found = [cookie("login").trim().toLowerCase()].filter(Boolean);
    if (found.join() !== names.join()) {
      names = found;
      if (names[0]) loadColor(names[0]);
    }
    const all = [...names, ...words.map((w) => w.toLowerCase())];
    const key = all.join("\n");
    if (key === patternKey) return;
    patternKey = key;
    const escaped = all.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    // Longest first, so a phrase wins over a word inside it. Whole words only,
    // with or without an @ in front.
    escaped.sort((a, b) => b.length - a.length);
    pattern = escaped.length ? new RegExp(`(^|[^\\w@])(@?(?:${escaped.join("|")}))(?!\\w)`, "giu") : null;
  }

  function setColor(color) {
    if (color && /^#[0-9a-f]{6}$/i.test(color)) document.documentElement.style.setProperty("--tbc-me-color", color);
  }

  // Your chat name colour, for the box. Until it arrives (or if you never set
  // one), the box uses the colour of the text it's around.
  function loadColor(login) {
    tbcLookup("chatcolor", { login })
      .then((j) => {
        const color = j.color;
        setColor(color);
        if (color) chrome.storage.local.set({ myChatColor: color });
      })
      .catch(() => {});
  }

  const isMe = (text) => names.includes(text.trim().replace(/^@/, "").toLowerCase());

  function box(el) {
    el.classList.add("tbc-me");
  }

  // Wrap each mention of your name inside a plain text node. The original node
  // stays where it is (holding the text before the first mention), so Twitch's
  // own reference to it still points at a node in the page.
  function wrapText(node) {
    pattern.lastIndex = 0;
    const m = pattern.exec(node.nodeValue);
    if (!m) return;
    const start = m.index + m[1].length;
    const rest = node.splitText(start);
    const after = rest.splitText(m[2].length);
    const span = document.createElement("span");
    span.className = "tbc-me";
    rest.replaceWith(span);
    span.append(rest);
    wrapText(after);
  }

  function mark(line) {
    line.dataset.tbcMe = "1";
    const user = line.querySelector(USERNAME);
    if (user && isMe(user.textContent)) box(user);
    for (const m of line.querySelectorAll(MENTION)) {
      if (!m.matches(TWITCH_MENTION) && isMe(m.textContent)) box(m);
    }
    for (const t of line.querySelectorAll(TEXT)) {
      if (t.closest(MENTION) || t.querySelector(".tbc-me")) continue;
      for (const node of [...t.childNodes]) if (node.nodeType === Node.TEXT_NODE) wrapText(node);
    }
  }

  function scan() {
    readNames();
    if (!pattern) return;
    document.querySelectorAll(LINE).forEach((line) => {
      if (!line.dataset.tbcMe) mark(line);
    });
  }

  // Box new lines (and text Twitch fills into a line later) right as they're
  // added; the observer runs before the browser draws them.
  tbcWatch((records) => {
    readNames(); // cheap; picks up signing in or out
    if (!pattern) return;
    const lines = new Set();
    for (const r of records) {
      for (const node of r.addedNodes) {
        const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (!el || el.closest(".tbc-me")) continue; // our own boxes
        const line = el.closest(LINE);
        if (line) lines.add(line);
        else if (node.nodeType === Node.ELEMENT_NODE) node.querySelectorAll(LINE).forEach((l) => lines.add(l));
      }
    }
    lines.forEach(mark);
  }, 0);
  scan();

  chrome.storage.local.get(["highlightWords", "myChatColor"], (d) => {
    setColor(d.myChatColor);
    words = d.highlightWords || [];
    scan();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.highlightWords) return;
    words = changes.highlightWords.newValue || [];
    scan();
  });
});

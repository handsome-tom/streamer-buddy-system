// Mod talk: the first two tabs of the speech-bubble button in the chat box (phrases.js draws
// the tabs; Chat tools, the quick phrases, is the last).
//
// Streamer messages: a mod messages the streamer whose chat this is, the same three ways
// the side panel does:
//   Question    the streamer answers with one tap (heart, yes, no, maybe) or a reply
//   Quick info  pops up on the streamer's screen for 2 minutes, no answer needed
//   !vanish     a short note on their screen for 30 seconds, then gone
//
// The conversation shows up in Twitch chat itself, as bubbles under the newest chat line
// (like chat notes): what you sent on the right in blue, the streamer's answers and
// anything they send you on the left in their name color. A question from the streamer
// comes with its answer buttons right there. Only you see these bubbles.
//
// Sending only works in the chat of a streamer you're connected with in Streamer Buddy
// System (not your own channel); elsewhere the tab still shows everything, with a note on
// top saying why it can't send yet.
//
// Secret chat: a message only your network and the channel's mods see, posted as a chat
// note (chatnotes.js draws it, with a "Secret" tag) on the newest chat line. The relay
// keeps it from the streamer. Offered only once the relay says it can (state's
// "secretNotes"), so an older relay can never show one to the streamer.
// It goes through the same relay connection as flags and notes
// (background.js), so the StreamSpace button has to have been signed in once.
//
// Wrapped so its names don't clash with the other scripts, and only started if it's
// switched on (settings.js).
whenOn("modtalk", "Message the streamer from the chat box", () => {
  if ((window.top !== window && !window.TWITCH_ME)) return;

  const LINE = ".chat-line__message";
  const CHAT_LIST = '[data-test-selector="chat-scrollable-area__message-container"], .chat-scrollable-area__message-container';
  const MODES = {
    ask: {
      label: "Question",
      hint: "They answer with one tap: heart, yes, no or maybe.",
      max: 200,
      verb: "Ask",
      placeholder: (n) => `Ask ${n} something…`,
      icon: '<path d="M7.5 7.5a2.6 2.6 0 1 1 3.7 2.4c-.8.4-1.2 1-1.2 1.8v.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="15" r="1.2" fill="currentColor"/>',
    },
    info: {
      label: "Quick info",
      hint: "Pops up on their screen for 2 minutes. No answer needed.",
      max: 200,
      verb: "Send",
      placeholder: (n) => `Tell ${n} something quick…`,
      icon: '<path d="M11.2 2.5 4.5 11h4.6l-.9 6.5L15 9h-4.6z" fill="currentColor"/>',
    },
    love: {
      label: "!vanish",
      hint: "A short note on their screen for 30 seconds, then it's gone.",
      max: 80,
      verb: "Send",
      placeholder: () => "A little note that vanishes…",
      icon: '<path d="M10 3.2 11.6 8l4.9.2-3.9 3 1.4 4.7-4-2.8-4 2.8 1.4-4.7-3.9-3L8.4 8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    },
  };
  // The answers a streamer can give, as words.
  const SAID = { t: "♥ Thank you", y: "✓ Yes", n: "✕ No", m: "? Maybe", s: "Soon", o: "OK" };
  // What a mod can answer the streamer's questions with, here in chat.
  const REPLIES = [["t", "♥", "Thank you"], ["y", "✓", "Yes"], ["n", "✕", "No"], ["m", "?", "Maybe"]];

  let circle = { me: null, mutual: [], online: [], features: [] };
  const questions = new Map(); // id -> question, from the relay
  const shownInChat = new Set(); // "<id>:<what>" already put in chat, so nothing shows twice
  const draft = { mode: "ask", text: "", note: "", noteKind: "" };
  let pending = null; // the quick info or !vanish just sent, until the relay says how it went
  let pane = null; // the tab's contents while the pop-up shows it
  const people = new Map(); // login -> Promise<{ displayName, avatar }>

  function channelName() {
    const parts = location.pathname.split("/").filter(Boolean);
    const name = (parts[0] === "popout" || parts[0] === "moderator" ? parts[1] : parts[0])?.toLowerCase();
    return name && /^[a-z0-9_]+$/.test(name) ? name : null;
  }
  // Whose chat this is, if you can message them here.
  function streamer() {
    const c = channelName();
    return c && circle.me && c !== circle.me && circle.mutual.includes(c) ? c : null;
  }
  function person(login) {
    if (!people.has(login)) {
      people.set(login, tbcLookup("channels", { logins: login }).then((list) => list[0] || {}).catch(() => ({})));
    }
    return people.get(login);
  }
  const nameOf = (login) => window.TWITCH_SHOWN?.[login] || login;

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
  function send(m) {
    if (!port) {
      say("Refresh Twitch and try again", "bad");
      return false;
    }
    port.postMessage(m);
    return true;
  }

  function heard(m) {
    if (m.t === "people") {
      circle = { me: m.me, mutual: m.mutual || [], online: m.online || [], features: m.features || [] };
      redraw();
    } else if (m.t === "questions") {
      for (const q of m.list || []) questions.set(q.id, q);
      redraw();
    } else if (m.t === "q") {
      gotQuestion(m.q);
    } else if (m.t === "flashed" && (m.kind === "info" || m.kind === "love") && pending) {
      const p = pending;
      pending = null;
      if (m.reached) {
        toChat({ key: `sent-${Date.now()}`, mine: true, tag: p.kind === "love" ? "!vanish" : "Quick info", text: p.text, to: p.to });
        say(p.kind === "love" ? "Sent. It's on their screen for 30 seconds." : "Sent. It's on their screen for 2 minutes.", "good");
        draft.text = "";
      } else {
        say(`${nameOf(p.to)}'s StreamSpace isn't open right now, so it didn't go. Quick notes don't wait.`, "bad");
      }
      redraw();
    } else if (m.t === "flash" && (m.f?.kind === "info" || m.f?.kind === "love") && m.f.from === channelName()) {
      toChat({ key: `f:${m.f.id}`, from: m.f.from, tag: m.f.kind === "love" ? "!vanish" : "Quick info", text: m.f.text });
    } else if (m.t === "error" && pane) {
      say(m.why, "bad");
      pending = null;
    } else if (m.t === "needSignin" && pane) {
      say("Click the StreamSpace button and sign in first", "bad");
    }
  }

  function gotQuestion(q) {
    const old = questions.get(q.id);
    questions.set(q.id, q);
    const here = channelName();
    if (q.from === circle.me && q.to === here) {
      if (!old) toChat({ key: `${q.id}:asked`, mine: true, tag: q.note ? "Message" : "Question", text: q.text, to: q.to });
      if (q.answer && !old?.answer) {
        toChat({ key: `${q.id}:answer`, from: q.to, tag: "Answered", text: q.answer.text || SAID[q.answer.code] || "Answered", about: q.text });
        send({ t: "seen", id: q.id }); // you've seen it here, so the side panel doesn't ask again
      } else if (q.dismissed && !old?.dismissed) {
        toChat({ key: `${q.id}:passed`, from: q.to, tag: "Passed", text: "Saw it, no answer needed", about: q.text, quiet: true });
      }
    } else if (q.to === circle.me && q.from === here && !q.answer && !q.dismissed && !old) {
      toChat({ key: `${q.id}:ask`, from: q.from, tag: q.note ? "Message" : "Asks you", text: q.text, question: q });
    } else if (q.to === circle.me && (q.answer || q.dismissed)) {
      // Answered somewhere (here or the side panel): its buttons become what you said.
      const said = q.answer ? `You answered ${q.answer.text || SAID[q.answer.code] || ""}` : "You passed on this one";
      document.querySelectorAll(`[data-tbc-mtq="${CSS.escape(q.id)}"] .tbc-mt-reply`).forEach((r) => r.replaceChildren(Object.assign(document.createElement("span"), { className: "tbc-mt-reply__done", textContent: said })));
    }
    redraw();
  }

  // ===== Bubbles in chat ======================================================================

  // Under the newest chat line, like a reply; if there's no line yet, at the end of chat.
  function toChat(b) {
    if (shownInChat.has(b.key)) return;
    shownInChat.add(b.key);
    const lines = document.querySelectorAll(LINE);
    const line = [...lines].reverse().find((l) => !l.closest('.chat-input, [class*="chat-input-tray"]'));
    let stack = line?.querySelector(":scope > .tbc-mtstack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "tbc-mtstack";
      if (line) line.append(stack);
      else {
        const list = document.querySelector(CHAT_LIST);
        if (!list) return;
        list.append(stack);
      }
    }
    stack.append(bubble(b));
    // Keep the newest in view, as chat does, unless you've scrolled up to read.
    const scroller = stack.closest(".simplebar-scroll-content, [data-a-target='chat-scroller'] .simplebar-scroll-content") || stack.closest("[class*='scrollable']");
    if (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160) scroller.scrollTop = scroller.scrollHeight;
  }

  function bubble(b) {
    const mine = !!b.mine;
    const who = mine ? circle.me : b.from;
    const el = document.createElement("div");
    el.className = `tbc-mt-bubble${mine ? " tbc-mt-bubble--mine" : ""}${b.quiet ? " tbc-mt-bubble--quiet" : ""}`;
    if (b.question) el.dataset.tbcMtq = b.question.id;
    const main = document.createElement("div");
    main.className = "tbc-mt-bubble__main";
    const head = document.createElement("div");
    head.className = "tbc-mt-bubble__head";
    const pic = document.createElement("span");
    pic.className = "tbc-mt-bubble__pic";
    pic.textContent = (nameOf(who) || "?")[0].toUpperCase();
    const name = document.createElement("b");
    name.textContent = mine ? `You → ${nameOf(b.to)}` : nameOf(who);
    const tag = document.createElement("span");
    tag.className = "tbc-mt-bubble__tag";
    tag.textContent = b.tag;
    const when = document.createElement("span");
    when.className = "tbc-mt-bubble__when";
    when.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    head.append(pic, name, tag, when);
    main.append(head);
    if (b.about) {
      const about = document.createElement("div");
      about.className = "tbc-mt-bubble__about";
      about.textContent = `“${b.about}”`;
      main.append(about);
    }
    const text = document.createElement("div");
    text.className = "tbc-mt-bubble__text";
    text.textContent = b.text;
    main.append(text);
    if (b.question) {
      const row = document.createElement("div");
      row.className = "tbc-mt-reply";
      for (const [code, mark, label] of REPLIES) {
        const r = document.createElement("button");
        r.type = "button";
        r.className = `tbc-mt-reply__btn tbc-mt-reply__btn--${code}`;
        r.title = label;
        r.setAttribute("aria-label", label);
        r.textContent = mark;
        r.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!send({ t: "answer", id: b.question.id, code })) return;
          row.replaceChildren(Object.assign(document.createElement("span"), { className: "tbc-mt-reply__done", textContent: `You answered ${SAID[code]}` }));
        });
        row.append(r);
      }
      main.append(row);
    }
    el.append(main);
    person(who).then((p) => {
      if (p.displayName) name.textContent = mine ? `You → ${p.displayName}` : p.displayName;
      if (mine && b.to) person(b.to).then((t) => t.displayName && (name.textContent = `You → ${t.displayName}`));
      if (!p.avatar) return;
      const img = document.createElement("img");
      img.className = "tbc-mt-bubble__pic";
      img.src = p.avatar;
      img.alt = "";
      pic.replaceWith(img);
    });
    return el;
  }

  // ===== The tab (phrases.js asks for it) =====================================================

  function say(text, kind = "") {
    draft.note = text;
    draft.noteKind = kind;
    redraw();
  }
  function redraw() {
    if (pane?.isConnected) fill(pane);
    if (secretPane?.isConnected) fillSecret(secretPane);
  }

  function sendNow() {
    const to = streamer();
    const text = draft.text.trim();
    if (!text) return;
    if (!to) return say(circle.me ? `You and ${nameOf(channelName() || "this streamer")} need to connect in StreamSpace first` : "Sign in with the StreamSpace button first", "bad");
    const mode = draft.mode;
    if (mode === "ask") {
      if (send({ t: "ask", to, text: text.slice(0, MODES.ask.max) })) {
        draft.text = "";
        say("Asked. Their answer will show up right here in chat.", "good");
      }
    } else if (send({ t: "flash", kind: mode, to, text: text.slice(0, MODES[mode].max) })) {
      pending = { kind: mode, to, text };
      say("Sending…");
    }
  }

  function fill(el) {
    pane = el;
    const focused = el.contains(document.activeElement) && document.activeElement.classList.contains("tbc-mt__text");
    el.textContent = "";
    el.className = "tbc-mt";
    const to = streamer();
    const here = channelName();
    // Can't send here: say why on top, and show everything else anyway.
    if (!to) {
      const notice = document.createElement("div");
      notice.className = "tbc-mt__notice";
      const big = document.createElement("b");
      const small = document.createElement("span");
      if (!circle.me) {
        big.textContent = "Sign in to message the streamer";
        small.textContent = "Click the StreamSpace button at the top of Twitch and sign in once.";
      } else if (here === circle.me) {
        big.textContent = "This is your own channel";
        small.textContent = "Your mods message you from their chat. Your answers go back to them.";
      } else {
        big.textContent = `You and ${nameOf(here || "this streamer")} aren't connected`;
        small.textContent = "Connect in StreamSpace (the StreamSpace button, then Connections) to message them here.";
      }
      notice.append(big, small);
      el.append(notice);
    }
    const target = to || here || "the streamer";

    // Who you're talking to.
    if (to) {
    const who = document.createElement("div");
    who.className = "tbc-mt__who";
    const pic = document.createElement("span");
    pic.className = "tbc-mt__pic";
    pic.textContent = nameOf(to)[0].toUpperCase();
    const words = document.createElement("div");
    words.className = "tbc-mt__words";
    const name = document.createElement("b");
    name.textContent = nameOf(to);
    const on = circle.online.includes(to);
    const state = document.createElement("span");
    state.className = `tbc-mt__state${on ? " tbc-mt__state--on" : ""}`;
    state.textContent = on ? "StreamSpace open · they'll see it now" : "StreamSpace closed · questions wait for them";
    words.append(name, state);
    who.append(pic, words);
    person(to).then((p) => {
      if (p.displayName) name.textContent = p.displayName;
      if (!p.avatar) return;
      const img = document.createElement("img");
      img.className = "tbc-mt__pic";
      img.src = p.avatar;
      img.alt = "";
      pic.replaceWith(img);
    });
    if (on) who.classList.add("tbc-mt__who--on");
    el.append(who);
    }

    // Question / Quick info / !vanish.
    const modes = document.createElement("div");
    modes.className = "tbc-mt__modes";
    modes.setAttribute("role", "radiogroup");
    modes.setAttribute("aria-label", "What to send");
    for (const [key, m] of Object.entries(MODES)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `tbc-mt__mode tbc-mt__mode--${key}${draft.mode === key ? " tbc-mt__mode--on" : ""}`;
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(draft.mode === key));
      b.innerHTML = `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">${m.icon}</svg>`;
      b.append(m.label);
      b.addEventListener("click", () => {
        draft.mode = key;
        draft.note = "";
        fill(el);
        el.querySelector(".tbc-mt__text")?.focus();
      });
      modes.append(b);
    }
    el.append(modes);

    const mode = MODES[draft.mode];
    const hint = document.createElement("p");
    hint.className = "tbc-mt__hint";
    hint.textContent = mode.hint;
    el.append(hint);

    const form = document.createElement("form");
    form.className = `tbc-mt__form tbc-mt__form--${draft.mode}`;
    const box = document.createElement("textarea");
    box.className = "tbc-mt__text";
    box.rows = 2;
    box.maxLength = mode.max;
    box.placeholder = mode.placeholder(nameOf(target));
    box.value = draft.text.slice(0, mode.max);
    box.spellcheck = true;
    const row = document.createElement("div");
    row.className = "tbc-mt__row";
    const count = document.createElement("span");
    count.className = "tbc-mt__count";
    const keys = document.createElement("span");
    keys.className = "tbc-mt__keys";
    keys.textContent = "Enter to send";
    const go = document.createElement("button");
    go.type = "submit";
    go.className = "tbc-mt__go";
    go.textContent = mode.verb;
    const sync = () => {
      draft.text = box.value;
      const left = mode.max - box.value.length;
      count.textContent = left <= 20 ? `${left} left` : "";
      go.disabled = !to || !box.value.trim();
    };
    box.addEventListener("input", sync);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendNow();
      }
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      sendNow();
    });
    row.append(count, keys, go);
    form.append(box, row);
    el.append(form);
    sync();
    if (draft.note) {
      const note = document.createElement("p");
      note.className = `tbc-mt__note${draft.noteKind ? ` tbc-mt__note--${draft.noteKind}` : ""}`;
      note.textContent = draft.note;
      el.append(note);
    }

    // Your latest questions to them, and how they went.
    const mineHere = [...questions.values()].filter((q) => q.from === circle.me && q.to === to && !q.withdrawn).sort((a, b) => b.at - a.at).slice(0, 4);
    if (mineHere.length) {
      const head = document.createElement("div");
      head.className = "tbc-mt__head";
      head.textContent = "Recent";
      const list = document.createElement("div");
      list.className = "tbc-mt__recent";
      for (const q of mineHere) {
        const r = document.createElement("div");
        r.className = "tbc-mt__item";
        const t = document.createElement("span");
        t.className = "tbc-mt__itemtext";
        t.textContent = q.text;
        const s = document.createElement("span");
        const answered = q.answer ? q.answer.text || SAID[q.answer.code] || "Answered" : "";
        s.className = `tbc-mt__chip${q.answer ? " tbc-mt__chip--done" : q.dismissed ? " tbc-mt__chip--quiet" : q.note ? " tbc-mt__chip--quiet" : ""}`;
        s.textContent = q.answer ? answered : q.dismissed ? "Seen" : q.note ? (q.seenAt ? "Seen" : "Sent") : "Waiting";
        r.append(t, s);
        list.append(r);
      }
      el.append(head, list);
    }
    if (focused) {
      const t = el.querySelector(".tbc-mt__text");
      t.focus();
      t.setSelectionRange(t.value.length, t.value.length);
    }
  }

  // ===== Secret chat ===========================================================================

  let secretPane = null;
  const secretDraft = { text: "", note: "", noteKind: "" };
  const SECRET_MAX = 300; // the relay's longest chat note

  // The newest chat line, to hang the note on, with its words as chat notes read them.
  function newestLine() {
    return [...document.querySelectorAll(LINE)].reverse().find((l) => l.dataset.aUser && !l.closest('.chat-input, [class*="chat-input-tray"]'));
  }
  function lineText(line) {
    let text = "";
    const walk = (node) => {
      if (node.nodeType === 3) text += node.textContent;
      else if (node.tagName === "IMG") text += node.alt || "";
      else if (!node.classList?.contains("tbc-notes") && !node.classList?.contains("tbc-mtstack")) node.childNodes.forEach(walk);
    };
    line.querySelectorAll('[data-a-target="chat-line-message-body"]').forEach(walk);
    return text.replace(/\s+/g, " ").trim();
  }

  function sendSecret() {
    const here = channelName();
    const body = secretDraft.text.trim().slice(0, SECRET_MAX);
    if (!body || !here) return;
    const sayS = (text, kind) => {
      secretDraft.note = text;
      secretDraft.noteKind = kind;
      redraw();
    };
    if (!circle.me) return sayS("Sign in with the StreamSpace button first", "bad");
    if (!circle.features.includes("secretNotes")) return sayS("Secret chat needs a StreamSpace update on the server first. Nothing was sent.", "bad");
    const line = newestLine();
    const text = line && lineText(line);
    if (!line || !text) return sayS("Wait for someone to chat first: it goes on the newest chat line.", "bad");
    const chatterName = line.querySelector(".chat-author__display-name")?.textContent.trim() || line.dataset.aUser;
    if (!send({ t: "note", secret: true, channel: here, chatter: line.dataset.aUser, chatterName, text, body, at: Date.now() })) return;
    secretDraft.text = "";
    sayS("Posted on the newest chat line. Only your network and the mods see it.", "good");
  }

  function fillSecret(el) {
    secretPane = el;
    const focused = el.contains(document.activeElement) && document.activeElement.classList.contains("tbc-mt__text");
    el.textContent = "";
    el.className = "tbc-mt tbc-mt--secret";
    const here = channelName();
    if (!circle.me) {
      const notice = document.createElement("div");
      notice.className = "tbc-mt__notice";
      notice.append(Object.assign(document.createElement("b"), { textContent: "Sign in to use Secret chat" }), Object.assign(document.createElement("span"), { textContent: "Click the StreamSpace button at the top of Twitch and sign in once." }));
      el.append(notice);
    }
    const top = document.createElement("div");
    top.className = "tbc-mt__secrethead";
    top.innerHTML = '<svg viewBox="0 0 20 20" width="22" height="22" aria-hidden="true"><rect x="4" y="9" width="12" height="8.5" rx="2.2" fill="currentColor"/><path d="M6.8 9V6.8a3.2 3.2 0 0 1 6.4 0V9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    const words = document.createElement("div");
    words.className = "tbc-mt__words";
    words.append(Object.assign(document.createElement("b"), { textContent: "Secret chat" }), Object.assign(document.createElement("span"), { className: "tbc-mt__state", textContent: `Only your network and ${nameOf(here || "the channel")}'s mods see it. Never the streamer.` }));
    top.append(words);
    el.append(top);
    const hint = document.createElement("p");
    hint.className = "tbc-mt__hint";
    hint.textContent = "It shows on the newest chat line, as a bubble with a Secret tag, for everyone in your network with StreamSpace.";
    el.append(hint);

    const form = document.createElement("form");
    form.className = "tbc-mt__form tbc-mt__form--secret";
    const box = document.createElement("textarea");
    box.className = "tbc-mt__text";
    box.rows = 2;
    box.maxLength = SECRET_MAX;
    box.placeholder = "Say something only your people see…";
    box.value = secretDraft.text;
    const row = document.createElement("div");
    row.className = "tbc-mt__row";
    const count = document.createElement("span");
    count.className = "tbc-mt__count";
    const keys = document.createElement("span");
    keys.className = "tbc-mt__keys";
    keys.textContent = "Enter to post";
    const go = document.createElement("button");
    go.type = "submit";
    go.className = "tbc-mt__go";
    go.textContent = "Post";
    const sync = () => {
      secretDraft.text = box.value;
      const left = SECRET_MAX - box.value.length;
      count.textContent = left <= 30 ? `${left} left` : "";
      go.disabled = !circle.me || !box.value.trim();
    };
    box.addEventListener("input", sync);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendSecret();
      }
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      sendSecret();
    });
    row.append(count, keys, go);
    form.append(box, row);
    el.append(form);
    sync();
    if (secretDraft.note) {
      const note = document.createElement("p");
      note.className = `tbc-mt__note${secretDraft.noteKind ? ` tbc-mt__note--${secretDraft.noteKind}` : ""}`;
      note.textContent = secretDraft.note;
      el.append(note);
    }
    if (focused) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
  }

  // The tabs phrases.js puts first in the chat box's pop-up, on any channel's chat.
  window.tbcModTalk = {
    tabs: () =>
      channelName()
        ? [
            { key: "talk", label: "Streamer messages", title: "Ask the streamer, send quick info or a !vanish note", fill, focus: () => pane?.querySelector(".tbc-mt__text")?.focus() },
            { key: "secret", label: "Secret chat", title: "A message only your network and the mods see in this chat, not the streamer", fill: fillSecret, focus: () => secretPane?.querySelector(".tbc-mt__text")?.focus() },
          ]
        : [],
  };

  connect();
});

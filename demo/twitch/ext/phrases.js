// Tabs: Streamer messages and Connections chat (modtalk.js, when it's there), then Chat tools
// (quick phrases and highlight words). Without modtalk.js it's quick phrases only, as before.
//
// Quick phrases: a small speech-bubble button in the chat box, to the left of the
// Bits and emote buttons, opens a list of things you say a lot (e.g. "Are we
// winning? tallglaDANCEbee"). Click one to put it in the chat box; it isn't
// sent until you press Enter. Add new ones at the bottom, × to remove.
//
// Emotes go in as their names (like the emote picker does); Twitch turns them
// into emotes in the chat box. The smiley button in the add row opens Twitch's
// own emote picker, and emotes you click there go into the phrase being added
// instead of the chat box.
//
// The list shows emotes as pictures. Pictures are learned from Twitch's emote
// picker whenever it's open (and from your pinned emotes), so an emote shows as
// a picture once you've had the picker open in a channel where you can use it.
//
// Above the phrases, a small "Highlight words" section: words to box in chat
// like your username (myname.js does the boxing), shown as chips with ×, plus a
// slim box to add one.
//
// Saved in chrome.storage.local:
//   "quickPhrases" [text]
//   "highlightWords" [words]
//   "emoteImages"  { emoteName: pictureUrl }
//
// Wrapped so its names don't clash with the other scripts, and only started if
// it's switched on (settings.js).
whenOn("phrases", "Quick phrases and highlight words", () => {
  const EMOTE_BUTTON = '[data-a-target="emote-picker-button"]';
  const CHAT_INPUT = '[data-a-target="chat-input"]';
  const PICKER = '[data-a-target="chat-emote-picker"]';
  const PICKER_EMOTE = '[data-test-selector="emote-button-clickable"], [data-tbc-pin]';
  const BUBBLE_PATH = "M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v12.2L8.3 16H20V6H4Zm3 3h10v2H7V9Zm0 3h7v2H7v-2Z";

  let phrases = [];
  // The chip lists above the phrases.
  const CHIPS = {
    hl: { key: "highlightWords", title: "Highlight words", hint: "Boxed in chat like your username, whole words only",
      placeholder: "+ word", chipClass: "tbc-me", max: 40, clean: (w) => w, removeTip: (w) => `Stop highlighting "${w}"` },
  };
  const chipLists = { hl: [] };
  let shell = null; // the pop-up
  let panel = null; // what's in the tab showing
  let tab = "phrases"; // always opens on Chat tools; "talk" (Streamer messages), "connections" (Connections chat) or "phrases" (Chat tools)
  let picking = false; // the emote picker is open for adding to a phrase
  let images = {};      // emote name -> picture url

  function alive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  chrome.storage.local.get("quickPhrases", (d) => {
    // First time: start with the example you gave.
    phrases = d.quickPhrases || ["Are we winning?"];
    if (!d.quickPhrases && alive()) chrome.storage.local.set({ quickPhrases: phrases });
  });
  chrome.storage.local.get("highlightWords", (d) => (chipLists.hl = d.highlightWords || []));
  chrome.storage.local.get("emoteImages", (d) => (images = { ...images, ...(d.emoteImages || {}) }));
  // Pinned emotes (pins.js) are saved by ID, so their pictures are known even
  // before the picker has been opened.
  // They also show at the top of Chat tools ("Your emotes"), to click into the chat box.
  let pinned = [];
  const pinnedSrc = (p) => (p.id ? `https://static-cdn.jtvnw.net/emoticons/v2/${p.id}/default/dark/2.0` : p.src || images[p.name] || "");
  function learnPinned(list) {
    pinned = Array.isArray(list) ? list.filter((p) => p?.name) : [];
    for (const p of pinned) {
      if (p.id && !images[p.name]) images[p.name] = `https://static-cdn.jtvnw.net/emoticons/v2/${p.id}/default/dark/1.0`;
    }
  }
  chrome.storage.sync.get("pinnedEmotes", (d) => learnPinned(d.pinnedEmotes));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.pinnedEmotes) return;
    learnPinned(changes.pinnedEmotes.newValue);
    if (panel && tab === "phrases") fill();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.emoteImages) images = changes.emoteImages.newValue || {};
    if (changes.quickPhrases) phrases = changes.quickPhrases.newValue || [];
    if (changes.highlightWords) chipLists.hl = changes.highlightWords.newValue || [];
    if (panel && tab === "phrases" && (changes.quickPhrases || changes.emoteImages || changes.highlightWords)) fill();
  });

  // Note the picture of every emote showing in Twitch's picker.
  function learnImages() {
    let found = 0;
    for (const img of document.querySelectorAll(`${PICKER} [data-test-selector="emote-button-clickable"] img`)) {
      const name = img.alt;
      if (name && img.src && images[name] !== img.src) {
        images[name] = img.src;
        found++;
      }
    }
    if (found && alive()) chrome.storage.local.set({ emoteImages: images });
  }

  const save = () => alive() && chrome.storage.local.set({ quickPhrases: phrases });

  // ===== The button ==============================================================

  function addButton() {
    const emote = document.querySelector(EMOTE_BUTTON);
    if (!emote) return;
    // The emote button sits in its own wrapper inside the row of chat-box buttons.
    const row = emote.parentElement?.parentElement;
    if (!row || row.querySelector(".tbc-phrases-btn")) return;
    row.classList.add("tbc-chat-buttons");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tbc-phrases-btn";
    b.title = "Message the streamer, and your quick phrases";
    b.setAttribute("aria-label", "Message the streamer, and quick phrases");
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="${BUBBLE_PATH}"></path></svg>`;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (panel) close();
      else open();
    });
    row.prepend(b); // far left: quick phrases, then Bits, then emotes
  }

  // ===== Putting text in the chat box ===========================================

  function insert(text) {
    const input = document.querySelector(CHAT_INPUT);
    if (!input) return;
    input.focus();
    // Add after whatever is already typed, with a space between.
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    const typed = input.textContent.replace(/\uFEFF/g, "");
    const lead = typed && !/\s$/.test(typed) ? " " : "";
    pasteInto(input, lead + text + " ");
  }

  // Hand text to Twitch's chat box as a paste. Typing it into the page directly
  // shows the text but Twitch doesn't register it (its "Send a message"
  // placeholder stays and Enter wouldn't send it); a paste goes through Twitch.
  function pasteInto(input, text) {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    const paste = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    input.dispatchEvent(paste);
    if (!paste.defaultPrevented) document.execCommand("insertText", false, text);
  }

  // ===== The pop-up ===============================================================

  function close() {
    if (!panel) return;
    stopPicking();
    shell.remove();
    shell = panel = null;
  }

  // ===== Emotes into the phrase being added =====================================

  // Twitch leaves the picker in the page after closing it, so ask its button.
  const pickerOpen = () => document.querySelector(EMOTE_BUTTON)?.getAttribute("aria-expanded") === "true";

  function startPicking() {
    picking = true;
    if (!pickerOpen()) document.querySelector(EMOTE_BUTTON)?.click();
    panel?.querySelector(".tbc-phrases__emote")?.classList.add("tbc-phrases__emote--on");
  }

  function stopPicking() {
    if (!picking) return;
    picking = false;
    panel?.querySelector(".tbc-phrases__emote")?.classList.remove("tbc-phrases__emote--on");
    // Close Twitch's picker again.
    if (pickerOpen()) document.querySelector(EMOTE_BUTTON)?.click();
    place();
  }

  // While picking, a click on an emote in Twitch's picker (or the Pinned row) adds
  // its name to the phrase instead of the chat box.
  window.addEventListener("click", (e) => {
    if (!picking || !panel) return;
    const emote = e.target.closest?.(PICKER_EMOTE);
    if (!emote || !emote.closest(PICKER)) return;
    e.preventDefault();
    e.stopPropagation();
    const name = emote.dataset.tbcPin || emote.dataset.aTarget || emote.getAttribute("aria-label");
    const pic = emote.querySelector("img")?.src;
    if (name && pic && images[name] !== pic) {
      images[name] = pic;
      if (alive()) chrome.storage.local.set({ emoteImages: images });
    }
    const input = panel.querySelector(".tbc-phrases__new:not(.tbc-phrases__chipnew)");
    if (!name || !input) return;
    input.value = (input.value && !/\s$/.test(input.value) ? input.value + " " : input.value) + name + " ";
  }, true);

  function open() {
    tab = "phrases"; // the pop-up always opens on Chat tools
    shell = document.createElement("div");
    shell.className = "tbc-phrases";
    for (const type of ["keydown", "keyup", "keypress"]) {
      shell.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === "keydown" && e.key === "Escape") close();
      });
    }
    panel = document.createElement("div");
    panel.className = "tbc-phrases__body";
    shell.append(panel);
    document.body.append(shell);
    fill();
    focusTab();
  }

  // The tabs along the top: modtalk.js's (Streamer messages, Connections chat) first, then
  // Chat tools (quick phrases and highlight words). All the same height, so switching
  // doesn't make the pop-up jump.
  // Each tab is a pixel icon (the side panel's 16×16 style) with its name small under it, in
  // the side panel's pixel font: Silkscreen (fonts/silkscreen.woff2, SIL Open Font License,
  // fonts/silkscreen-OFL.txt), loaded once, under its own name so it can't clash with Twitch's.
  const TOOLS_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor" shape-rendering="crispEdges"><path d="M1 1h10v1h-10zM0 2h12v1h-12zM0 3h2v1h-2zM10 3h2v1h-2zM0 4h12v1h-12zM0 5h2v1h-2zM7 5h5v1h-5zM0 6h12v1h-12zM1 7h9v1h-9zM2 8h2v1h-2zM11 8h2v1h-2zM2 9h1v1h-1zM9 9h6v1h-6zM9 10h6v1h-6zM8 11h3v1h-3zM13 11h3v1h-3zM8 12h3v1h-3zM13 12h3v1h-3zM9 13h6v1h-6zM9 14h6v1h-6zM11 15h2v1h-2z"/></svg>'; // a chat box with a gear
  function pixelFont() {
    if (document.getElementById("tbc-pixelfont")) return;
    const f = document.createElement("style");
    f.id = "tbc-pixelfont";
    f.textContent = `@font-face { font-family: "TBC Silkscreen"; font-weight: 400; font-display: swap; src: url("${chrome.runtime.getURL("fonts/silkscreen.woff2")}") format("woff2"); }`;
    document.head.append(f);
  }
  const extraTabs = () => window.tbcModTalk?.tabs() || [];
  function focusTab() {
    const t = extraTabs().find((x) => x.key === tab);
    if (t) t.focus();
    else panel.querySelector(".tbc-phrases__new:not(.tbc-phrases__chipnew)")?.focus();
  }
  function drawTabs(tabs) {
    shell.querySelector(".tbc-phrases__tabs")?.remove();
    shell.classList.toggle("tbc-phrases--tabs", !!tabs.length);
    if (!tabs.length) return;
    pixelFont();
    const bar = document.createElement("div");
    bar.className = "tbc-phrases__tabs";
    bar.setAttribute("role", "tablist");
    for (const t of [...tabs, { key: "phrases", label: "Chat tools", title: "Chat tools: your quick phrases and highlight words", icon: TOOLS_ICON }]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `tbc-phrases__tab tbc-phrases__tab--${t.key}${tab === t.key ? " tbc-phrases__tab--on" : ""}`;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(tab === t.key));
      b.setAttribute("aria-label", t.label);
      b.title = t.title;
      if (t.icon) {
        const icon = document.createElement("span");
        icon.className = "tbc-phrases__tabicon";
        icon.innerHTML = t.icon;
        b.append(icon);
      }
      const words = document.createElement("span");
      words.className = "tbc-phrases__tabname";
      words.textContent = t.short || t.label; // short on the tab, so all three fit with their icons; the full name on hover
      b.append(words);
      b.addEventListener("click", () => {
        if (tab === t.key) return;
        stopPicking();
        tab = t.key;
        fill();
        focusTab();
      });
      bar.append(b);
    }
    shell.prepend(bar);
  }

  // Your emotes: the ones you've pinned in Twitch's emote picker (pins.js; right-click an
  // emote there to pin it). Click one to add it to the chat box; the pop-up stays open, so
  // you can click a few in a row.
  function fillPinned() {
    if (!pinned.length) return;
    const head = document.createElement("div");
    head.className = "tbc-phrases__head tbc-phrases__head--sub";
    head.textContent = "Your emotes";
    const row = document.createElement("div");
    row.className = "tbc-phrases__emotes";
    for (const p of pinned) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tbc-phrases__emote";
      b.title = b.ariaLabel = p.name;
      const src = pinnedSrc(p);
      if (src) {
        const img = document.createElement("img");
        img.src = src;
        img.alt = p.name;
        b.append(img);
      } else b.textContent = p.name;
      b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the pop-up open
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        insert(p.name);
      });
      row.append(b);
    }
    panel.append(head, row);
  }

  function fill() {
    const tabs = extraTabs();
    if (!tabs.some((t) => t.key === tab)) tab = tabs.length && tab !== "phrases" ? tabs[0].key : "phrases";
    drawTabs(tabs);
    // A new box when the tab changes, so the other tab's drawing can't land in this one.
    if (panel.dataset.tab !== tab) {
      const fresh = document.createElement("div");
      fresh.dataset.tab = tab;
      panel.replaceWith(fresh);
      panel = fresh;
    }
    const other = tabs.find((t) => t.key === tab);
    if (other) {
      panel.className = "tbc-phrases__body";
      other.fill(panel);
      place();
      return;
    }
    panel.className = "tbc-phrases__body";
    const draft = panel.querySelector(".tbc-phrases__new:not(.tbc-phrases__chipnew)")?.value || "";
    const drafts = Object.fromEntries(Object.keys(CHIPS).map((k) => [k, panel.querySelector(`.tbc-phrases__chipnew[data-kind="${k}"]`)?.value || ""]));
    panel.textContent = "";
    fillPinned();
    for (const kind of Object.keys(CHIPS)) fillChips(kind, drafts[kind]);
    const head = document.createElement("div");
    head.className = "tbc-phrases__head tbc-phrases__head--sub";
    head.textContent = "Quick phrases";
    panel.append(head);

    const list = document.createElement("div");
    list.className = "tbc-phrases__list";
    if (!phrases.length) {
      const empty = document.createElement("div");
      empty.className = "tbc-phrases__empty";
      empty.textContent = "Nothing saved yet. Add one below.";
      list.append(empty);
    }
    phrases.forEach((text, i) => {
      const row = document.createElement("div");
      row.className = "tbc-phrases__row";
      const use = document.createElement("button");
      use.type = "button";
      use.className = "tbc-phrases__use";
      showWithEmotes(use, text);
      use.title = "Put in the chat box (press Enter to send)";
      use.addEventListener("click", () => {
        close();
        insert(text);
      });
      const x = document.createElement("button");
      x.type = "button";
      x.className = "tbc-phrases__x";
      x.textContent = "×";
      x.title = "Remove";
      x.addEventListener("click", () => {
        phrases = phrases.filter((_, j) => j !== i);
        save();
        fill();
      });
      row.append(use, x);
      list.append(row);
    });
    panel.append(list);

    const add = document.createElement("form");
    add.className = "tbc-phrases__add";
    add.innerHTML =
      `<input class="tbc-phrases__new" type="text" maxlength="500" placeholder="Add a phrase (emote names work too)" spellcheck="false" autocomplete="off">` +
      `<button type="button" class="tbc-phrases__emote" title="Add emotes from the emote picker" aria-label="Add emotes"></button>` +
      `<button type="submit" class="tbc-phrases__save">Add</button>`;
    const input = add.querySelector("input");
    input.value = draft;
    // Same smiley as Twitch's own emote button.
    const emoteBtn = add.querySelector(".tbc-phrases__emote");
    const icon = document.querySelector(`${EMOTE_BUTTON} svg`);
    if (icon) emoteBtn.append(icon.cloneNode(true));
    else emoteBtn.textContent = "☺";
    emoteBtn.classList.toggle("tbc-phrases__emote--on", picking);
    emoteBtn.addEventListener("click", () => (picking ? stopPicking() : startPicking()));
    add.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      if (!phrases.includes(text)) phrases = [...phrases, text];
      input.value = "";
      save();
      fill();
      panel.querySelector(".tbc-phrases__new:not(.tbc-phrases__chipnew)").focus();
    });
    panel.append(add);
    place();
  }

  // ===== Highlight words ==============================================================

  function fillChips(kind, draft) {
    const c = CHIPS[kind];
    const save = () => alive() && chrome.storage.local.set({ [c.key]: chipLists[kind] });
    const box = document.createElement("div");
    box.className = "tbc-hl";
    const head = document.createElement("div");
    head.className = "tbc-phrases__head";
    head.textContent = c.title;
    head.title = c.hint;
    box.append(head);

    const chips = document.createElement("div");
    chips.className = "tbc-hl__chips";
    for (const word of chipLists[kind]) {
      const chip = document.createElement("span");
      chip.className = `${c.chipClass} tbc-hl__chip`;
      chip.append(word);
      const x = document.createElement("button");
      x.type = "button";
      x.className = "tbc-hl__x";
      x.textContent = "×";
      x.title = c.removeTip(word);
      x.addEventListener("click", () => {
        chipLists[kind] = chipLists[kind].filter((w) => w !== word);
        save();
        fill();
      });
      chip.append(x);
      chips.append(chip);
    }

    const add = document.createElement("form");
    add.className = "tbc-hl__add";
    add.innerHTML =
      `<input class="tbc-phrases__new tbc-phrases__chipnew" type="text" spellcheck="false" autocomplete="off">`;
    const input = add.querySelector("input");
    input.dataset.kind = kind;
    input.maxLength = c.max;
    input.placeholder = c.placeholder;
    input.value = draft;
    input.title = `${c.hint}. Type and press Enter.`;
    add.addEventListener("submit", (e) => {
      e.preventDefault();
      const word = c.clean(input.value.trim());
      if (!word) return;
      if (!chipLists[kind].some((w) => w.toLowerCase() === word.toLowerCase())) chipLists[kind] = [...chipLists[kind], word];
      input.value = "";
      save();
      fill();
      panel.querySelector(`.tbc-phrases__chipnew[data-kind="${kind}"]`).focus();
    });
    chips.append(add);
    box.append(chips);
    panel.append(box);
  }

  // Show a phrase with its emotes as pictures (words we have a picture for).
  function showWithEmotes(el, text) {
    for (const part of text.split(/(\s+)/)) {
      if (images[part]) {
        const img = document.createElement("img");
        img.className = "tbc-phrases__emoteimg";
        img.src = images[part];
        img.alt = img.title = part;
        el.append(img);
      } else if (part) {
        el.append(part);
      }
    }
  }

  // Sit just above the chat box, as wide as it (or above Twitch's emote picker
  // while that's open for picking, so they don't overlap).
  function place() {
    const box = document.querySelector(CHAT_INPUT)?.closest(".chat-input") || document.querySelector(CHAT_INPUT);
    if (!box || !shell) return;
    const r = box.getBoundingClientRect();
    const width = Math.max(260, r.width);
    const picker = picking && pickerOpen() && document.querySelector(PICKER);
    const top = picker ? Math.min(r.top, picker.getBoundingClientRect().top) : r.top;
    shell.style.width = width + "px";
    shell.style.left = Math.max(8, Math.min(r.left, innerWidth - width - 8)) + "px";
    shell.style.bottom = innerHeight - top + 6 + "px";
    shell.style.maxHeight = Math.max(120, top - 14) + "px";
    // With tabs, one fixed height for all of them (the inside scrolls), so it doesn't jump.
    shell.style.height = shell.classList.contains("tbc-phrases--tabs") ? Math.min(440, Math.max(120, top - 14)) + "px" : "";
  }

  // Clicking anywhere else closes it (clicks in the emote picker while picking don't).
  window.addEventListener("pointerdown", (e) => {
    if (!shell || shell.contains(e.target) || e.target.closest?.(".tbc-phrases-btn")) return;
    if (picking && e.target.closest?.(PICKER)) return;
    close();
  }, true);
  window.addEventListener("resize", place);

  // Twitch redraws the chat box now and then; put the button back when it does.
  tbcWatch(() => {
    if (!alive()) return;
    addButton();
    if (pickerOpen()) learnImages();
    if (panel) {
      // If Twitch's picker was closed some other way, stop picking.
      if (picking && !pickerOpen()) stopPicking();
      place();
    }
  }, 300);
  addButton();
});

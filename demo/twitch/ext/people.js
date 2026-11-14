// Notes on chatters. Right-click a username in chat to open a flyout where you can:
//   - tag where you know them from (search the channels you follow, pick one or more)
//   - pick their pronouns
//   - write a note about them
// Chat then shows the channel's picture before their name and their pronouns after it.
//
// Twitch keeps follow lists private, so the list to search comes from the
// Following > Channels page (twitch.tv/directory/following/channels): whenever
// that page is open, this reads every channel on it and saves the list.
// The flyout's "Refresh" link opens that page in a small window that does this
// and closes itself.
//
// Saved in chrome.storage.local:
//   "follows"           { updated, list: [{ login, name, img }] } (all your accounts' follows)
//   "followsByAccount"  { login: { updated, list } }               (each account's own)
//   "person:<login>"  { known: [{ login, name, img }], pronouns, note }
//
// Wrapped so its names don't clash with the other scripts, and only started if
// it's switched on (settings.js).
whenOn("people", "Chatter notes (right-click a name)", () => {
  const USERNAME = '[data-a-target="chat-message-username"]';
  const FOLLOWING_PATH = "/directory/following/channels";
  const SYNC_HASH = "#tbc-sync";
  const PRONOUNS = ["He/him", "She/her", "They/them", "They/she", "They/he", "Other"];
  const MAX_RESULTS = 6;

  let follows = [];
  let followsUpdated = 0;
  const people = {}; // login -> { known, pronouns, note }
  let version = 0;   // bumps whenever people change, so chat lines redraw

  // See streak.js: after a reload, copies left in open tabs lose chrome.storage.
  function alive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  chrome.storage.local.get(null, (data) => {
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith("person:")) people[k.slice(7)] = v;
    }
    if (data.follows) {
      follows = data.follows.list || [];
      followsUpdated = data.follows.updated || 0;
    }
    version++;
    decorateAll();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let touched = false;
    for (const [k, { newValue }] of Object.entries(changes)) {
      if (k.startsWith("person:")) {
        if (newValue) people[k.slice(7)] = newValue;
        else delete people[k.slice(7)];
        touched = true;
      } else if (k === "follows" && newValue) {
        follows = newValue.list || [];
        followsUpdated = newValue.updated || 0;
        if (flyout) renderFlyout();
      }
    }
    if (touched) {
      version++;
      decorateAll();
    }
  });

  // Saves p as this person's info (or forgets them if it's all empty).
  function savePerson(login, p) {
    people[login] = p;
    version++;
    decorateAll();
    if (!alive()) return;
    if (!p.known.length && !p.pronouns && !p.note) chrome.storage.local.remove("person:" + login);
    else chrome.storage.local.set({ ["person:" + login]: p });
  }

  // ===== Follow list ===============================================================

  function harvestFollows() {
    const found = new Map();
    for (const card of document.querySelectorAll('main [data-a-target="user-card-modal"]')) {
      const a = card.querySelector('a[href^="/"][aria-label]');
      if (!a) continue;
      const login = a.getAttribute("href").slice(1).toLowerCase();
      if (!/^[a-z0-9_]+$/.test(login)) continue;
      // The picture sits a few levels above the name link.
      let box = card;
      let img = null;
      for (let i = 0; i < 6 && box && !img; i++) {
        img = box.querySelector('img[src*="jtv_user_pictures"], img.tw-image-avatar');
        box = box.parentElement;
      }
      found.set(login, { login, name: a.getAttribute("aria-label"), img: img ? img.src : "" });
    }
    return [...found.values()];
  }

  // On the Following > Channels page: scroll until every channel has loaded, then save.
  async function syncFollows() {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(2500);
    const scroller = document.querySelector("main .root-scrollable");
    // Collect at every step on the way down: Twitch can drop cards that have
    // scrolled out of view, so reading only at the end can miss most of them.
    const found = new Map();
    const collect = () => harvestFollows().forEach((f) => found.set(f.login, f));
    let same = 0;
    for (let i = 0; i < 200 && same < 4; i++) {
      const before = found.size;
      collect();
      const atBottom = !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      if (scroller && !atBottom) scroller.scrollTop += scroller.clientHeight * 0.8;
      await wait(atBottom ? 900 : 400);
      same = atBottom && found.size === before ? same + 1 : 0;
    }
    collect();
    const list = [...found.values()];
    if (list.length && alive()) {
      // Each of your accounts (see accounts.js) has its own follows; keep a list per
      // account and save "follows" as all of them together.
      const me = (document.cookie.match(/(?:^|;\s*)login=([^;]+)/) || [])[1] || "unknown";
      chrome.storage.local.get("followsByAccount", ({ followsByAccount: byAccount = {} }) => {
        // If the page didn't fully load, don't let a partial read replace this
        // account's full list: add what was found to the old one.
        const before = byAccount[me]?.list || [];
        let merged = list;
        if (list.length < before.length * 0.8) {
          const seen = new Set(list.map((f) => f.login));
          merged = [...list, ...before.filter((f) => !seen.has(f.login))];
        }
        byAccount[me] = { updated: Date.now(), list: merged };
        const all = new Map();
        for (const acct of Object.values(byAccount)) for (const f of acct.list) if (!all.has(f.login)) all.set(f.login, f);
        chrome.storage.local.set({ followsByAccount: byAccount, follows: { updated: Date.now(), list: [...all.values()] } });
      });
    }
    // Opened by the flyout's Refresh link: close when done.
    if (location.hash === SYNC_HASH && window.opener) setTimeout(() => window.close(), 500);
  }

  if (location.pathname === FOLLOWING_PATH) syncFollows();

  function refreshFollows() {
    window.open("https://www.twitch.tv" + FOLLOWING_PATH + SYNC_HASH, "tbc-follows", "width=520,height=640");
  }

  // ===== Showing tags in chat ======================================================

  function pronounLabel(p) {
    if (!p.pronouns) return "";
    if (p.pronouns === "Other") return (p.pronounsOther || "other").toLowerCase();
    return p.pronouns.toLowerCase();
  }

  // The tag in chat: first letters, "she/her" -> "S/H". When a word starts with
  // the same letter as the one before, use its second letter: "he/him" -> "H/I".
  // Except they/them, which is "T/T" so it doesn't look like they/he ("T/H").
  function pronounShort(label) {
    if (label === "they/them") return "T/T";
    const words = label.split("/").map((w) => w.trim()).filter(Boolean);
    if (words.length < 2) return label;
    let prev = "";
    return words.map((w) => {
      const letter = (w[0] === prev && w[1] ? w[1] : w[0]).toUpperCase();
      prev = w[0];
      return letter;
    }).join("/");
  }

  function summary(p) {
    const parts = [];
    if (p.known.length) parts.push("Known from " + p.known.map((k) => k.name).join(", "));
    const pr = pronounLabel(p);
    if (pr) parts.push(pr);
    if (p.note) parts.push("Note: " + p.note);
    return parts.join("\n");
  }

  function decorate(el) {
    const login = (el.dataset.aUser || el.textContent || "").trim().toLowerCase();
    if (!login) return;
    const stamp = `${version}`;
    if (el.dataset.tbcV === stamp) return;
    el.dataset.tbcV = stamp;
    // Twitch wraps the name in a clickable span; tags go just outside it.
    const anchor = el.closest(".chat-line__username") || el;
    const parent = anchor.parentElement;
    if (!parent) return;
    parent.querySelectorAll(":scope > .tbc-known, :scope > .tbc-pronouns").forEach((n) => n.remove());
    const p = people[login];
    if (!p || (!p.known.length && !p.pronouns && !p.note)) return;
    const tip = summary(p);
    if (p.known.length) {
      const known = document.createElement("span");
      known.className = "tbc-known";
      known.title = tip;
      for (const k of p.known) {
        const img = document.createElement("img");
        img.alt = k.name;
        if (k.img) img.src = k.img;
        known.append(img);
      }
      anchor.before(known);
    }
    const pr = pronounLabel(p);
    if (pr || p.note) {
      const tag = document.createElement("span");
      tag.className = "tbc-pronouns" + (p.note ? " tbc-pronouns--note" : "");
      tag.textContent = pr ? pronounShort(pr) : "note";
      tag.title = tip;
      anchor.after(tag);
    }
  }

  function decorateAll() {
    document.querySelectorAll(USERNAME).forEach(decorate);
  }

  tbcWatch(decorateAll, 300);

  // ===== The flyout ================================================================

  let flyout = null; // { el, login, display, query }

  function closeFlyout() {
    if (!flyout) return;
    flushInputs();
    flyout.el.remove();
    flyout = null;
  }

  function person(login) {
    return people[login] || (people[login] = { known: [], pronouns: "", pronounsOther: "", note: "" });
  }

  function openFlyout(login, display, x, y) {
    closeFlyout();
    const el = document.createElement("div");
    el.className = "tbc-people";
    // Keep typing away from Twitch's keyboard shortcuts.
    for (const type of ["keydown", "keyup", "keypress"]) {
      el.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === "keydown" && e.key === "Escape") closeFlyout();
      });
    }
    document.body.append(el);
    flyout = { el, login, display, query: "", x, y };
    renderFlyout();
    el.querySelector(".tbc-people__search").focus();
  }

  // Put the flyout by the click, nudged so all of it stays on screen as it grows.
  function place() {
    if (!flyout) return;
    const { el, x, y } = flyout;
    el.style.left = Math.max(8, Math.min(x, innerWidth - el.offsetWidth - 8)) + "px";
    el.style.top = Math.max(8, Math.min(y, innerHeight - el.offsetHeight - 8)) + "px";
  }

  function matches(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const chosen = person(flyout.login).known.map((k) => k.login);
    const list = follows.filter((f) => !chosen.includes(f.login) &&
      (f.login.includes(q) || f.name.toLowerCase().includes(q)));
    // Names that start with the search first.
    list.sort((a, b) => (b.login.startsWith(q) - a.login.startsWith(q)) || a.login.localeCompare(b.login));
    return list.slice(0, MAX_RESULTS);
  }

  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function avatar(src) {
    const img = h("img", "tbc-people__avatar");
    img.alt = "";
    if (src) img.src = src;
    return img;
  }

  function renderFlyout() {
    if (!flyout) return;
    flushInputs();
    const { el, login, display } = flyout;
    const p = person(login);
    const keepFocus = document.activeElement && el.contains(document.activeElement)
      ? document.activeElement.dataset.focusKey : null;
    el.textContent = "";

    const head = h("div", "tbc-people__head");
    head.append(h("strong", null, display));
    if (display.toLowerCase() !== login) head.append(h("span", "tbc-people__login", login));
    const close = h("button", "tbc-people__close", "×");
    close.type = "button";
    close.title = "Close";
    close.addEventListener("click", closeFlyout);
    head.append(close);
    el.append(head);

    // --- Known from
    el.append(h("div", "tbc-people__label", "Known from"));
    if (p.known.length) {
      const chips = h("div", "tbc-people__chips");
      for (const k of p.known) {
        const chip = h("span", "tbc-people__chip");
        chip.append(avatar(k.img), h("span", null, k.name));
        const x = h("button", "tbc-people__chip-x", "×");
        x.type = "button";
        x.title = `Remove ${k.name}`;
        x.addEventListener("click", () => {
          p.known = p.known.filter((c) => c.login !== k.login);
          savePerson(login, p);
          renderFlyout();
        });
        chip.append(x);
        chips.append(chip);
      }
      el.append(chips);
    }
    const search = h("input", "tbc-people__search");
    search.type = "text";
    search.placeholder = follows.length ? "Search channels you follow" : "Type a channel name";
    search.value = flyout.query;
    search.dataset.focusKey = "search";
    const pick = (ch) => {
      p.known.push(ch);
      flyout.query = "";
      savePerson(login, p);
      renderFlyout();
    };
    search.addEventListener("input", () => {
      flyout.query = search.value;
      drawResults();
    });
    search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const first = results.querySelector("button");
      if (first) first.click();
    });
    el.append(search);
    const results = h("div", "tbc-people__results");
    el.append(results);
    function drawResults() {
      results.textContent = "";
      const q = flyout.query.trim();
      for (const f of matches(q)) {
        const b = h("button", "tbc-people__result");
        b.type = "button";
        b.append(avatar(f.img), h("span", null, f.name));
        b.addEventListener("click", () => pick(f));
        results.append(b);
      }
      // Not someone you follow? Tag the typed name anyway.
      const typed = q.toLowerCase().replace(/^@/, "");
      if (/^[a-z0-9_]{2,}$/.test(typed) && !follows.some((f) => f.login === typed) &&
          !p.known.some((k) => k.login === typed)) {
        const b = h("button", "tbc-people__result tbc-people__result--typed");
        b.type = "button";
        b.append(avatar(""), h("span", null, `Use "${typed}"`));
        b.addEventListener("click", () => pick({ login: typed, name: typed, img: "" }));
        results.append(b);
      }
      place();
    }
    drawResults();
    const sync = h("div", "tbc-people__sync");
    sync.append(h("span", null, follows.length
      ? `${follows.length} followed channels saved`
      : "Your follow list isn't loaded yet"));
    const refresh = h("button", "tbc-people__link", follows.length ? "Refresh" : "Load it");
    refresh.type = "button";
    refresh.title = "Opens your Following page in a small window, reads it and closes";
    refresh.addEventListener("click", refreshFollows);
    sync.append(refresh);
    el.append(sync);

    // --- Pronouns
    el.append(h("div", "tbc-people__label", "Pronouns"));
    const row = h("div", "tbc-people__pronouns");
    for (const opt of PRONOUNS) {
      const b = h("button", "tbc-people__pronoun" + (p.pronouns === opt ? " tbc-people__pronoun--on" : ""), opt);
      b.type = "button";
      b.addEventListener("click", () => {
        p.pronouns = p.pronouns === opt ? "" : opt; // click again to clear
        savePerson(login, p);
        renderFlyout();
        if (p.pronouns === "Other") el.querySelector(".tbc-people__other")?.focus();
      });
      row.append(b);
    }
    el.append(row);
    if (p.pronouns === "Other") {
      const other = h("input", "tbc-people__other");
      other.type = "text";
      other.maxLength = 30;
      other.placeholder = "Their pronouns";
      other.value = p.pronounsOther || "";
      other.dataset.focusKey = "other";
      other.addEventListener("change", () => {
        p.pronounsOther = other.value.trim();
        savePerson(login, p);
      });
      el.append(other);
    }

    // --- Note
    el.append(h("div", "tbc-people__label", "Note"));
    const note = h("textarea", "tbc-people__note");
    note.rows = 3;
    note.maxLength = 500;
    note.placeholder = "Big fan of the Bills";
    note.value = p.note || "";
    note.dataset.focusKey = "note";
    note.addEventListener("change", () => {
      p.note = note.value.trim();
      savePerson(login, p);
    });
    el.append(note);

    // --- Footer
    const foot = h("div", "tbc-people__foot");
    const clear = h("button", "tbc-people__clear", "Clear all");
    clear.type = "button";
    clear.addEventListener("click", () => {
      el.querySelectorAll("input, textarea").forEach((i) => (i.value = "")); // so they aren't re-saved
      savePerson(login, { known: [], pronouns: "", pronounsOther: "", note: "" });
      renderFlyout();
    });
    const done = h("button", "tbc-people__done", "Done");
    done.type = "button";
    done.addEventListener("click", closeFlyout);
    foot.append(clear, done);
    el.append(foot);

    place();
    if (keepFocus) el.querySelector(`[data-focus-key="${keepFocus}"]`)?.focus();
  }

  // Inputs save on "change", which fires when they lose focus. Closing the
  // flyout removes them first, so save whatever is typed before closing.
  function flushInputs() {
    if (!flyout) return;
    const p = person(flyout.login);
    const note = flyout.el.querySelector(".tbc-people__note");
    const other = flyout.el.querySelector(".tbc-people__other");
    let changed = false;
    if (note && note.value.trim() !== (p.note || "")) {
      p.note = note.value.trim();
      changed = true;
    }
    if (other && other.value.trim() !== (p.pronounsOther || "")) {
      p.pronounsOther = other.value.trim();
      changed = true;
    }
    if (changed) savePerson(flyout.login, p);
  }
  // Right-click a username in chat to open the flyout.
  window.addEventListener("contextmenu", (e) => {
    const name = e.target.closest?.(`${USERNAME}, .chat-line__username`);
    if (!name) return;
    const el = name.matches(USERNAME) ? name : name.querySelector(USERNAME);
    if (!el) return;
    const login = (el.dataset.aUser || el.textContent || "").trim().toLowerCase();
    if (!login) return;
    e.preventDefault();
    e.stopPropagation();
    openFlyout(login, el.textContent.trim() || login, e.clientX + 4, e.clientY + 4);
  }, true);

  // Clicking anywhere outside closes it.
  window.addEventListener("pointerdown", (e) => {
    if (flyout && !flyout.el.contains(e.target)) closeFlyout();
  }, true);
});

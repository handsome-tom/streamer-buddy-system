// Feature switches. The side panel's Settings page (its gear; the hub asks
// hub-panel.js) lists the bigger features, each with an on/off switch; a
// feature that's switched off doesn't start at all, from the next time Twitch loads.
//
// This loads before the other scripts. Each of them starts through
// whenOn(key, label, start), which also puts it on the list, and the list is
// saved for that page, so it only shows the features this copy has.
//
// Saved in chrome.storage.local:
//   "featuresOff"  [key]              features switched off (everything else is on)
//   "featureList"  [{ key, label }]   the features this copy has, for the pop-up
//   "tbcInstalled" ms                 when this install first ran on Twitch (see the end)

const tbcFeatures = []; // [{ key, label }], in the order the scripts load
let tbcOff = null;      // keys switched off, once loaded
const tbcWaiting = [];

// The tester copy (build-tester.py sets TBC_TESTER to true) keeps every feature off until the
// tester has agreed to the tester agreement (agree.html saves "testerAgreed" { v, name, at }).
// Until then, Twitch shows a small bar that opens it. Agreeing turns everything on, no reload.
const TBC_TESTER = false;
const TBC_AGREEMENT = "1"; // also in agree.js; a new number asks everyone again
const tbcAgreed = (a) => !TBC_TESTER || (!!a && a.v === TBC_AGREEMENT);

chrome.storage.local.get(["featuresOff", "featureList", "testerAgreed"], (d) => {
  tbcOff = d.featuresOff || [];
  if (tbcAgreed(d.testerAgreed)) tbcWaiting.splice(0).forEach((go) => go());
  else tbcAwaitAgreement();
  // Every script has registered by now (they all run before this answer comes back).
  if ((window.top === window || !!window.TWITCH_ME) && JSON.stringify(d.featureList) !== JSON.stringify(tbcFeatures)) {
    chrome.storage.local.set({ featureList: tbcFeatures });
  }
});

let tbcStarting = ""; // label of the feature starting right now, to name its page watchers

function whenOn(key, label, start) {
  if (!tbcFeatures.some((f) => f.key === key)) tbcFeatures.push({ key, label });
  const go = () => {
    if (tbcOff.includes(key)) return;
    // Every feature starts in the same go, so one that fails must not stop the
    // ones after it (that used to leave later features missing until a reload).
    tbcStarting = label;
    try {
      start();
    } catch (e) {
      console.error(`[StreamSpace] ${label} failed to start:`, e);
    } finally {
      tbcStarting = "";
    }
  };
  tbcOff && tbcReady ? go() : tbcWaiting.push(go);
}

let tbcReady = true; // false while the tester agreement is waiting (the tester copy)

function tbcAwaitAgreement() {
  tbcReady = false;
  let bar = null;
  if ((window.top === window || !!window.TWITCH_ME) && location.hostname === "www.twitch.tv") {
    bar = document.createElement("div");
    bar.className = "tbc-agreebar";
    bar.setAttribute("role", "status");
    bar.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;display:flex;gap:14px;align-items:center;" +
      "padding:10px 10px 10px 18px;border-radius:999px;background:#1f1f2b;color:#efeff1;font:14px/1.3 system-ui,-apple-system,'Segoe UI',sans-serif;" +
      "box-shadow:0 12px 40px rgba(0,0,0,.55),0 0 0 1px rgba(156,124,244,.35)";
    const text = document.createElement("span");
    text.textContent = "StreamSpace is off until you agree to the tester agreement.";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Read and agree";
    btn.style.cssText = "border:0;border-radius:999px;padding:8px 16px;background:#9c7cf4;color:#fff;font:600 14px/1 system-ui,-apple-system,'Segoe UI',sans-serif;cursor:pointer";
    btn.addEventListener("click", () => tbcAlive() && chrome.runtime.sendMessage({ type: "openAgreement" }));
    bar.append(text, btn);
    (document.body || document.documentElement).append(bar);
  }
  chrome.storage.onChanged.addListener(function on(changes, area) {
    if (area !== "local" || !changes.testerAgreed || !tbcAgreed(changes.testerAgreed.newValue)) return;
    chrome.storage.onChanged.removeListener(on);
    bar?.remove();
    tbcReady = true;
    tbcWaiting.splice(0).forEach((go) => go());
  });
}

// ===== One page watcher for every script =====================================
// Twitch changes the page constantly: every chat line, every hover. Instead of
// each script watching the whole page itself (and running on every change), they
// all register here with tbcWatch(fn, every): there's one MutationObserver, and
// each fn runs at most once per `every` ms, after the page has been busy, with
// the changes gathered since its last run (or null when there were too many to
// keep). `every` of 0 runs fn inside the observer itself, before the browser
// draws (myname.js needs that so lines don't shift when they get boxed).
//
// After the extension is reloaded, the copy still running in already-open tabs
// loses chrome.* ("Extension context invalidated"); the watcher then stops.
const tbcWatchers = []; // { fn, every, due, records, full }
let tbcObserver = null;
const TBC_KEEP_RECORDS = 400;

function tbcAlive() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

// Each run is guarded: a watcher that throws is reported in the console (at most
// once a minute) and keeps being called, and it never stops the other watchers.
// One that takes long is reported too, so lag can be traced to a feature.
// Changes made only by our own scripts (tbc- elements and tbc- classes) don't
// wake anyone, so the features can't keep re-running each other in a loop.
// In a tab you're not looking at, watchers run at most every 2 s.
const TBC_SLOW_MS = 50;
const TBC_HIDDEN_EVERY = 2000;

function tbcRun(w, got) {
  const t0 = performance.now();
  try {
    w.fn(got);
  } catch (e) {
    if (Date.now() - w.errAt > 60000) {
      w.errAt = Date.now();
      console.error(`[StreamSpace] ${w.label} hit an error (it keeps running):`, e);
    }
  }
  const took = performance.now() - t0;
  if (took > TBC_SLOW_MS && Date.now() - w.slowAt > 30000) {
    w.slowAt = Date.now();
    console.warn(`[StreamSpace] ${w.label} took ${Math.round(took)} ms`);
  }
}

const tbcOwnClass = (c) => c.startsWith("tbc-");
function tbcOwnNode(n) {
  return n.nodeType !== Node.ELEMENT_NODE ? n.nodeType === Node.TEXT_NODE : [...n.classList].some(tbcOwnClass);
}
// True when a change was made by us: a tbc- class switched, or tbc- things added
// to or removed from one of our own elements.
function tbcOwnChange(r) {
  if (r.type === "attributes") {
    const was = new Set((r.oldValue || "").split(/\s+/).filter(Boolean));
    const now = new Set((r.target.getAttribute?.("class") || "").split(/\s+/).filter(Boolean));
    for (const c of was) if (!now.has(c) && !tbcOwnClass(c)) return false;
    for (const c of now) if (!was.has(c) && !tbcOwnClass(c)) return false;
    return true;
  }
  if (r.target.nodeType !== Node.ELEMENT_NODE || ![...r.target.classList].some(tbcOwnClass)) {
    // Inside a Twitch element: ours only if everything that came and went is an element of ours.
    for (const n of r.addedNodes) if (n.nodeType !== Node.ELEMENT_NODE || !tbcOwnNode(n)) return false;
    for (const n of r.removedNodes) if (n.nodeType !== Node.ELEMENT_NODE || !tbcOwnNode(n)) return false;
    return true;
  }
  for (const n of r.addedNodes) if (!tbcOwnNode(n)) return false;
  for (const n of r.removedNodes) if (!tbcOwnNode(n)) return false;
  return true;
}

function tbcSchedule(w) {
  if (w.due) return;
  w.due = setTimeout(() => {
    w.due = 0;
    const got = w.full ? null : w.records;
    w.records = [];
    w.full = false;
    if (tbcAlive()) tbcRun(w, got);
  }, document.hidden ? Math.max(w.every, TBC_HIDDEN_EVERY) : w.every);
}

function tbcWatch(fn, every = 250) {
  const w = { fn, every, due: 0, records: [], full: false, errAt: 0, slowAt: 0,
    label: tbcStarting || `page watcher ${tbcWatchers.length + 1}` };
  tbcWatchers.push(w);
  if (tbcObserver) return;
  tbcObserver = new MutationObserver((all) => {
    if (!tbcAlive()) return tbcObserver.disconnect();
    const records = all.filter((r) => !tbcOwnChange(r));
    if (!records.length) return;
    for (const w of tbcWatchers) {
      if (!w.every) {
        tbcRun(w, records);
        continue;
      }
      if (!w.full) {
        if (w.records.length + records.length > TBC_KEEP_RECORDS) {
          w.full = true;
          w.records = [];
        } else {
          for (const r of records) w.records.push(r);
        }
      }
      tbcSchedule(w);
    }
  });
  tbcObserver.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true,
  });
}

// ===== Keeping what you've saved across reinstalls (backup.js) ===============
// www.twitch.tv's own localStorage holds a copy of your saved things, so they
// outlive the extension: a fresh install (no "tbcInstalled" mark yet) takes the
// copy back the first time Twitch loads. After that, every change is copied over
// again a moment later. Only in the page itself, not the player or embed frames.
if ((window.top === window || !!window.TWITCH_ME) && location.hostname === "www.twitch.tv") {
  let tbcMirrorDue = 0;
  const tbcMirror = () => {
    clearTimeout(tbcMirrorDue);
    tbcMirrorDue = setTimeout(async () => {
      if (!tbcAlive()) return;
      try {
        localStorage.setItem(TBC_BACKUP_KEY, JSON.stringify(await tbcBackupCollect()));
      } catch {} // the site's storage is full or blocked; the pop-up's Back up still works
    }, 5000);
  };
  chrome.storage.local.get("tbcInstalled", async (d) => {
    if (!d.tbcInstalled) {
      try {
        const copy = JSON.parse(localStorage.getItem(TBC_BACKUP_KEY) || "null");
        if (copy) await tbcBackupApply(copy);
      } catch {}
      if (tbcAlive()) chrome.storage.local.set({ tbcInstalled: Date.now() });
    }
    tbcMirror();
    chrome.storage.onChanged.addListener((changes) => {
      if (Object.keys(changes).some((k) => !tbcBackupSkips(k))) tbcMirror();
    });
  });
}

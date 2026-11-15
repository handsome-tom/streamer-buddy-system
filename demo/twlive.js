// A real live stream through Twitch's own embed player, watch-only, for the demo's
// "And on Twitch itself" section. Twitch only autoplays a player it can see whole: fully on
// screen, not faded, at least 400 by 300, and with nothing at all painted over it, even a
// see-through layer. In testing the only placement that started every time was a layer of
// its own at the very end of the page, on top of everything, so that's where it goes,
// lined up over the demo's spot (the demo itself sits in the front page's frame).
// Watch-only: the player is inert (no clicks, no keyboard focus), muted, and its frame
// ignores the pointer, so nothing in it can type, follow, cheer, gift or spend.
//
// ssLiveOver(where, tell, { under }): where() gives the spot in page coordinates
// ({ x, y, w, h }); `under` is how tall the page's sticky top bar is, so the player tucks
// under it on scroll. Returns place(), to call whenever the spot may have moved.
// tell({ state, channel }) hears "searching", "live", "none" (no big stream is live) or
// "error" (Twitch's script didn't load).
(() => {
  const CHANNELS = ["kaicenat", "ishowspeed", "ludwig", "pokimane", "zackrawrr", "hasanabi", "caseoh_", "lirik", "sodapoppin", "tarik", "jynxzi", "xqc", "summit1g", "shroud", "tfue"];
  const STEP_MS = 8000; // the scout's wait for Twitch to say online or offline
  const PLAY_MS = 7000; // the visible player's wait for the stream to actually start

  let loading = null;
  const loadTwitch = () => loading || (loading = new Promise((ok, no) => {
    if (window.Twitch?.Player) return ok(window.Twitch);
    const s = document.createElement("script");
    s.src = "https://player.twitch.tv/js/embed/v1.js";
    s.onload = () => (window.Twitch?.Player ? ok(window.Twitch) : no(new Error("no player")));
    s.onerror = () => no(new Error("no script"));
    document.head.append(s);
  }));

  // No clicks, no focus, nothing read out: inert covers the player's frame and everything in it.
  const lock = (el) => {
    el.inert = true;
    el.setAttribute("aria-hidden", "true");
    el.querySelectorAll("iframe").forEach((f) => { f.tabIndex = -1; f.style.pointerEvents = "none"; f.style.border = "0"; });
  };

  window.ssLiveOver = (where, tell = () => {}, { under = 0 } = {}) => {
    const slot = document.createElement("div");
    slot.style.cssText = "position:absolute;z-index:2147483647;border-radius:10px;overflow:hidden;background:transparent";
    document.body.append(slot);
    const place = () => {
      const r = where();
      if (!r || !r.w) return;
      Object.assign(slot.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      tuck();
    };
    // On top of everything, so it would ride over the sticky top bar: trim off whatever part
    // of it is under the bar.
    const tuck = () => {
      if (!under) return;
      const cut = Math.max(0, Math.min(slot.offsetHeight, under - slot.getBoundingClientRect().top));
      slot.style.clipPath = cut ? `inset(${cut}px 0 0 0)` : "";
    };
    if (under) addEventListener("scroll", tuck, { passive: true });
    addEventListener("resize", place);
    place();
    run(slot, tell, under);
    return place;
  };

  const run = async (slot, tell, under) => {
    let T;
    try { T = await loadTwitch(); } catch { return tell({ state: "error" }); }
    tell({ state: "searching" });

    // Fully on screen, below the top bar: Twitch won't start a stream otherwise.
    let seen = false;
    const onSeen = [];
    new IntersectionObserver((es) => {
      seen = es.some((x) => x.intersectionRatio >= 0.98);
      if (seen) onSeen.splice(0).forEach((f) => f());
    }, { rootMargin: `-${under}px 0px 0px 0px`, threshold: [0, 0.5, 0.98, 1] }).observe(slot);
    const whenSeen = (f) => (seen ? f() : onSeen.push(f));

    // A hidden scout (no video) finds who's online, so "is offline" screens never show.
    const scoutEl = document.createElement("div");
    scoutEl.style.cssText = "position:fixed;left:-10000px;top:0;width:400px;height:300px;opacity:0;pointer-events:none";
    document.body.append(scoutEl);
    lock(scoutEl);
    const scout = new T.Player(scoutEl, { channel: CHANNELS[0], width: 400, height: 300, parent: [location.hostname], muted: true, autoplay: false });
    lock(scoutEl);

    let i = 0, scouting = true, stepTimer = 0, playTimer = 0, main = null, mainEl = null, live = false, tries = 0;
    const next = () => {
      clearTimeout(stepTimer);
      if (++tries >= CHANNELS.length) { scouting = false; return tell({ state: "none" }); }
      i = (i + 1) % CHANNELS.length;
      scouting = true;
      scout.setChannel(CHANNELS[i]);
      stepTimer = setTimeout(next, STEP_MS);
    };
    scout.addEventListener(T.Player.OFFLINE, () => scouting && next());
    scout.addEventListener(T.Player.ONLINE, () => {
      if (!scouting) return;
      scouting = false;
      clearTimeout(stepTimer);
      whenSeen(() => show(CHANNELS[i]));
    });
    stepTimer = setTimeout(next, STEP_MS);

    // The visible player, on a channel the scout found online.
    const show = (channel) => {
      live = false;
      if (!main) {
        mainEl = document.createElement("div");
        mainEl.className = "twlive__player";
        mainEl.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
        slot.append(mainEl);
        lock(mainEl);
        main = new T.Player(mainEl, { channel, width: "100%", height: "100%", parent: [location.hostname], muted: true, autoplay: true });
        lock(mainEl);
        main.addEventListener(T.Player.PLAYING, () => {
          clearTimeout(playTimer);
          if (live) return;
          live = true;
          main.setMuted(true);
          lock(mainEl);
          tell({ state: "live", channel: CHANNELS[i] });
        });
        // The stream ended: find the next one.
        main.addEventListener(T.Player.OFFLINE, () => {
          if (!live) return;
          live = false;
          mainEl.style.visibility = "hidden";
          tell({ state: "searching" });
          tries = 0;
          next();
        });
      } else {
        mainEl.style.visibility = "";
        main.setChannel(channel);
      }
      // Online but it never starts: an age-gated stream ("intended for certain audiences")
      // waits for a click it never gets. Skip it. Scrolled partly away instead? Try again
      // once it's back in full view.
      clearTimeout(playTimer);
      playTimer = setTimeout(() => {
        if (live) return;
        if (!seen) return whenSeen(() => show(channel));
        mainEl.style.visibility = "hidden"; // out of sight while the scout looks again
        tell({ state: "searching" });
        next();
      }, PLAY_MS);
    };
  };
})();

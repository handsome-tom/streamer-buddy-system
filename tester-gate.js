// The tester agreement screen for the test site (test.streamspace.tv). Before anything on the
// test site can be used, the tester reads the tester agreement (tester-agreement.html), types
// their Twitch name, ticks the box and presses I agree. That's sent to the relay's consent log
// (POST /api/agree; the owner sees it in the dock's "Agreements, feedback & problems"), and this
// browser remembers it, so the screen only comes back when AGREEMENT_VERSION changes.
//
// Only on the test site (and anywhere with ?testergate, for trying it out); on streamspace.tv
// itself it does nothing. Only in the top window, so the playground's inner page doesn't ask twice.
(() => {
  const AGREEMENT_VERSION = "1"; // also in tester-agreement.html and the extension's agree.html
  const KEY = "ssTesterAgreed";
  const forced = /[?&]testergate\b/.test(location.search);
  if (window.top !== window) return;
  if (!/^test\./.test(location.hostname) && !forced) return;
  try {
    const had = JSON.parse(localStorage.getItem(KEY) || "null");
    if (had && had.v === AGREEMENT_VERSION && !forced) return;
  } catch {}

  const AGREE_URL = location.hostname === "localhost"
    ? "http://localhost:8788/api/agree"
    : "https://streamer-buddy-relay.handsome-tom.workers.dev/api/agree";

  const css = `
    #ssgate { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 16px;
      background: radial-gradient(120% 90% at 50% 0%, rgba(40, 36, 70, .97), rgba(8, 8, 12, .99));
      color: #d9d9e3; font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
    #ssgate * { box-sizing: border-box; }
    #ssgate .g { width: min(640px, 100%); height: min(760px, calc(100vh - 32px)); display: flex; flex-direction: column; gap: 14px; }
    #ssgate h1 { margin: 0; font-size: 26px; line-height: 1.2; color: #fff; }
    #ssgate p { margin: 0; }
    #ssgate .g > :not(iframe) { flex: none; }
    #ssgate .lead { color: #b9b9c8; }
    #ssgate iframe { position: static; inset: auto; height: auto; flex: 1 1 0; min-height: 120px; width: 100%; border: 0; border-radius: 6px;
      background: rgba(255, 255, 255, .035); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .05), 0 24px 60px rgba(0, 0, 0, .4); }
    #ssgate label { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; }
    #ssgate .name { display: grid; gap: 6px; }
    #ssgate input[type=text] { width: 100%; padding: 10px 12px; border: 0; border-radius: 6px; font: inherit; color: #fff;
      background: rgba(255, 255, 255, .07); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .08); outline: none; }
    #ssgate input[type=text]:focus { box-shadow: inset 0 0 0 2px #9c7cf4; }
    #ssgate input[type=checkbox] { width: 18px; height: 18px; margin: 2px 0 0; accent-color: #9c7cf4; flex: none; }
    #ssgate button { align-self: flex-start; padding: 11px 22px; border: 0; border-radius: 999px; font-family: inherit; font-size: 15px; font-weight: 600; line-height: 1; color: #fff; background: #9c7cf4; cursor: pointer; box-shadow: 0 10px 30px rgba(156, 124, 244, .35); }
    #ssgate button:disabled { opacity: .4; cursor: default; box-shadow: none; }
    #ssgate .err { color: #ff8b8b; min-height: 1.4em; }
    #ssgate a { color: #b9a6ff; }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  const gate = document.createElement("div");
  gate.id = "ssgate";
  gate.setAttribute("role", "dialog");
  gate.setAttribute("aria-modal", "true");
  gate.setAttribute("aria-labelledby", "ssgate-h");
  gate.innerHTML = `
    <form class="g" novalidate>
      <h1 id="ssgate-h">Before you start testing</h1>
      <p class="lead">This is an early, unreleased version of StreamSpace. Please read the tester agreement. In short: use it, break it, tell us what you think, but don't copy it or share it. We're all doing this in good faith.</p>
      <iframe src="/tester-agreement.html?bare" title="StreamSpace tester agreement"></iframe>
      <p><a href="/tester-agreement.html" target="_blank" rel="noopener">Open the agreement in its own tab</a></p>
      <div class="name"><span>Your Twitch name</span><input type="text" name="name" autocomplete="username" maxlength="40" spellcheck="false" placeholder="yourname"></div>
      <label><input type="checkbox" name="ok"><span>I've read the StreamSpace tester agreement and I agree to it.</span></label>
      <p class="err" aria-live="polite"></p>
      <button type="submit" disabled>I agree</button>
    </form>`;

  const show = () => {
    document.head.append(style);
    document.body.append(gate);
    document.documentElement.style.overflow = "hidden";
    const form = gate.querySelector("form");
    const name = form.elements.name;
    const ok = form.elements.ok;
    const btn = form.querySelector("button");
    const err = form.querySelector(".err");
    const check = () => (btn.disabled = !(name.value.trim().replace(/^@/, "") && ok.checked));
    form.addEventListener("input", check);
    form.addEventListener("change", check);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      check();
      if (btn.disabled) return;
      btn.disabled = true;
      err.textContent = "";
      const who = name.value.trim().replace(/^@/, "");
      let build = "";
      try {
        build = (await (await fetch("/version.txt", { cache: "no-store" })).text()).trim().slice(0, 12);
      } catch {}
      try {
        const res = await fetch(AGREE_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: who, where: "test site", version: AGREEMENT_VERSION, build: build && `build ${build}` }),
        });
        if (!res.ok) throw new Error(String(res.status));
        try {
          localStorage.setItem(KEY, JSON.stringify({ v: AGREEMENT_VERSION, name: who, at: Date.now() }));
        } catch {}
        gate.remove();
        style.remove();
        document.documentElement.style.overflow = "";
      } catch {
        err.textContent = "Couldn't reach StreamSpace's server to save that. Check your connection and press I agree again.";
        check();
      }
    });
    name.focus();
  };
  if (document.body) show();
  else document.addEventListener("DOMContentLoaded", show);
})();

// What the tests (specs.js) use: real dock panels in frames, pretend people on raw relay
// connections, and waiting for something to happen. Everything talks to the pretend relay
// in this page (demo/hub.js), never the real one.

// The same address play.html uses (with its ?v=), so a browser never runs an old copy.
import { Socket, resetRelay, pretendTwitch } from "../demo/hub.js?v=126";

export { pretendTwitch };
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until fn() gives something truthy (and return it), or fail saying what never happened.
export async function until(fn, what = "it", ms = 6000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await wait(50);
  }
  throw new Error(`Timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ""}`);
}

export function check(ok, what) {
  if (!ok) throw new Error(what);
}

let opened = [];

// A fresh start for each test: no panels, no pretend people, an empty relay.
// relaySettings: e.g. { OWNER_LOGIN: "tom" } for the allow list, as on the real relay.
export async function reset(relaySettings) {
  for (const o of opened) o.close();
  opened = [];
  document.getElementById("frames").replaceChildren();
  resetRelay(relaySettings);
  await wait(30);
}

// ----- Pretend people: a raw relay connection each, signed in as dev:<login> --------------
// invite: sign in carrying an invite link's code, as a page opened from one does.
export function person(login, { invite } = {}) {
  const ws = new Socket("wss://sandbox.invalid/ws");
  const got = [];
  const p = {
    login,
    got,
    state: null,
    questions: {},
    send(m) {
      check(ws.readyState === 1, `${login} isn't connected`);
      ws.send(JSON.stringify(m));
    },
    // The newest message of this type (and matching, if given) since `from`.
    async next(t, match = () => true, ms) {
      const from = got.length;
      return until(() => got.slice(from).find((m) => m.t === t && match(m)), `${login} to get "${t}"`, ms);
    },
    seen: (t, match = () => true) => got.find((m) => m.t === t && match(m)),
    close: () => ws.close(),
  };
  ws.onopen = () => ws.send(JSON.stringify({ t: "auth", token: `dev:${login}`, ...(invite ? { invite } : {}) }));
  ws.onclose = (e) => (p.closedWith = e.code);
  ws.onmessage = (e) => {
    if (e.data === "pong") return;
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    got.push(m);
    if (m.t === "state") {
      p.state = m;
      for (const q of m.questions || []) p.questions[q.id] = q;
    }
    if (m.t === "q") p.questions[m.q.id] = m.q;
  };
  // Is `other` connected to this person both ways?
  p.connectedTo = (other) => !!p.state?.connections?.some((c) => c.login === other && c.mutual);
  opened.push(p);
  p.ready = until(() => p.state, `${login} to sign in`);
  p.ready.catch(() => {}); // someone turned away never signs in: the test says if that matters
  return p;
}

// Two people who've added each other.
export async function friends(a, b) {
  await Promise.all([a.ready, b.ready]);
  a.send({ t: "connect", login: b.login });
  b.send({ t: "connect", login: a.login });
  await until(() => a.state?.connections?.some((c) => (c.login || c) === b.login && c.mutual !== false), `${a.login} and ${b.login} to be connected`);
}

// ----- Real panels ----------------------------------------------------------------------------
// "obs": the streamer's OBS chat dock (as the demo's left panel).
// "ext": a mod's side panel in Chrome (as the demo's right panel).
const ADDRESS = {
  obs: (login, extra) => `../?dev=${login}&livechat&ownchat&mock&lightms=6000&sandbox${extra}`,
  ext: (login, extra) => `../?dev=${login}&embed=ext&watch=streamer&modfor=streamer&sandbox${extra}`,
  page: (login, extra) => `../?dev=${login}&sandbox${extra}`,
};

export async function panel(login, kind = "ext", extra = "") {
  const frame = document.createElement("iframe");
  frame.title = `${login} (${kind})`;
  frame.src = ADDRESS[kind](login, extra ? `&${extra}` : "");
  document.getElementById("frames").append(frame);
  const p = {
    login,
    frame,
    get win() {
      return frame.contentWindow;
    },
    get doc() {
      return frame.contentDocument;
    },
    $: (sel) => frame.contentDocument?.querySelector(sel),
    $$: (sel) => [...(frame.contentDocument?.querySelectorAll(sel) || [])],
    text: () => frame.contentDocument?.body?.innerText || "",
    has: (s) => (frame.contentDocument?.body?.innerText || "").includes(s),
    errors: [],
    close: () => frame.remove(),
  };
  opened.push(p);
  await until(() => p.doc?.readyState === "complete" && p.doc.getElementById("main"), `${login}'s panel to load`, 10000);
  p.win.addEventListener("error", (e) => p.errors.push(String(e.message)));
  p.win.addEventListener("unhandledrejection", (e) => p.errors.push(String(e.reason?.message || e.reason)));
  return p;
}

// Type into a field and send its form, the way someone would.
export function typeAndSend(input, text) {
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const form = input.form || input.closest("form");
  if (form?.requestSubmit) form.requestSubmit();
  else input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

// The automatic tests. Each one starts on an empty pretend relay (see helpers.js), with
// real dock panels and pretend people, and checks one thing people rely on.
// Add a test: a new entry here, named the way you'd say what should happen.
//
// person(login): a pretend person on a raw relay connection (fast, no page).
// panel(login, "obs" | "ext"): the real dock, as the streamer's OBS dock or a mod's side panel.
// A person and a panel can share a login: the person then sees everything that panel does.

// The streamer and mod1, added to each other, with the streamer's OBS dock and mod1's side
// panel open, plus a pretend "watcher" on each login to see what the relay says.
async function streamerAndMod(h) {
  const streamerWatch = h.person("streamer");
  const modWatch = h.person("mod1");
  await h.friends(streamerWatch, modWatch);
  const streamer = await h.panel("streamer", "obs");
  const mod = await h.panel("mod1", "ext");
  await h.until(() => streamer.$("#quickTo option[value='mod1']"), "the dock to list mod1");
  await h.until(() => mod.$(".send__bar .ask__input"), "the side panel's ask box");
  return { streamer, mod, streamerWatch, modWatch };
}

const noErrors = (...panels) => {
  const errors = panels.flatMap((p) => p.errors);
  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
};

export const tests = {
  async "the streamer's OBS dock and a mod's side panel both load and sign in"(h) {
    const { streamer, mod } = await streamerAndMod(h);
    noErrors(streamer, mod);
  },

  async "a mod asks, the question shows on the streamer's dock, and their Yes goes back"(h) {
    const { streamer, mod, modWatch } = await streamerAndMod(h);
    h.typeAndSend(mod.$(".send__bar .ask__input"), "Can I run the poll now?");
    await h.until(() => streamer.has("Can I run the poll now?"), "the question on the streamer's dock");
    const yes = await h.until(() => streamer.$(".pill--answer.answer--y"), "a Yes button on the dock");
    yes.click();
    await h.until(() => Object.values(modWatch.questions).some((q) => q.text === "Can I run the poll now?" && q.answer?.code === "y"), "the relay to have the answer");
    await h.until(() => /Yes[\s\S]*Can I run the poll now\?/.test(mod.text()), "Yes in the mod's panel");
    await h.until(() => !streamer.has("Can I run the poll now?"), "the question to leave the streamer's bar");
    noErrors(streamer, mod);
  },

  async "the streamer asks from the bar and the mod's OK goes back"(h) {
    const { streamer, mod, streamerWatch } = await streamerAndMod(h);
    h.typeAndSend(streamer.$("#quickText"), "Can you post the Discord link?");
    await h.until(() => mod.has("Can you post the Discord link?"), "the question in the mod's panel");
    (await h.until(() => mod.$(".answer--o"), "an OK button in the mod's panel")).click();
    await h.until(() => Object.values(streamerWatch.questions).some((q) => q.text === "Can you post the Discord link?" && q.answer?.code === "o"), "the streamer to get OK");
    noErrors(streamer, mod);
  },

  async "a typed reply reaches the person who asked"(h) {
    const a = h.person("streamer");
    const b = h.person("mod1");
    await h.friends(a, b);
    a.send({ t: "ask", to: "mod1", text: "Who just raided?", options: ["y", "n"] });
    const { q } = await b.next("q", (m) => m.q.text === "Who just raided?");
    b.send({ t: "answer", id: q.id, code: "c", text: "It was Lump" });
    await a.next("q", (m) => m.q.id === q.id && m.q.answer?.text === "It was Lump");
  },

  async "dismissing a question tells the asker and clears it from the dock"(h) {
    const { streamer, modWatch } = await streamerAndMod(h);
    modWatch.send({ t: "ask", to: "streamer", text: "Timeout the spammer?", options: ["y", "n"] });
    await h.until(() => streamer.has("Timeout the spammer?"), "the question on the dock");
    (await h.until(() => streamer.$(".peek__dismiss, .qcard__dismiss"), "a dismiss button")).click();
    await h.until(() => Object.values(modWatch.questions).some((q) => q.text === "Timeout the spammer?" && q.dismissed), "the asker to hear it was dismissed");
    await h.until(() => !streamer.has("Timeout the spammer?"), "the dock to clear it");
  },

  async "a plain message has no answer buttons and can be marked seen"(h) {
    const a = h.person("mod1");
    const b = h.person("streamer");
    await h.friends(a, b);
    a.send({ t: "ask", to: "streamer", text: "Mic is a little quiet", note: true });
    const { q } = await b.next("q", (m) => m.q.text === "Mic is a little quiet");
    h.check(q.note, "it should arrive as a message, not a question");
    b.send({ t: "seen", id: q.id });
    await a.next("q", (m) => m.q.id === q.id && m.q.seenAt);
  },

  async "a mod can nudge a waiting question, and it climbs a level"(h) {
    const mod = h.person("mod1");
    const streamer = h.person("streamer");
    await h.friends(mod, streamer);
    mod.send({ t: "ask", to: "streamer", text: "Raid them after this game?", options: ["y", "n"] });
    const { q } = await streamer.next("q", (m) => m.q.text === "Raid them after this game?");
    mod.send({ t: "nudge", id: q.id });
    await streamer.next("q", (m) => m.q.id === q.id && m.q.nudges === 1);
  },

  async "quick info from a mod shows on the streamer's bar"(h) {
    const { streamer, modWatch } = await streamerAndMod(h);
    modWatch.send({ t: "flash", kind: "info", to: "streamer", text: "Ad break in 2 min" });
    await h.until(() => streamer.has("Ad break in 2 min"), "the quick info on the bar");
    noErrors(streamer);
  },

  async "a question sent while OBS is closed is waiting when the dock opens"(h) {
    const mod = h.person("mod1");
    const streamer = h.person("streamer");
    await h.friends(mod, streamer);
    streamer.close(); // OBS closed: the streamer isn't connected at all
    await h.wait(100);
    mod.send({ t: "ask", to: "streamer", text: "Should I start the giveaway?", options: ["y", "n"] });
    await h.wait(300);
    const dock = await h.panel("streamer", "obs");
    await h.until(() => dock.has("Should I start the giveaway?"), "the waiting question on the dock");
  },

  async "taking a question back removes it from the streamer's dock"(h) {
    const { streamer, modWatch } = await streamerAndMod(h);
    modWatch.send({ t: "ask", to: "streamer", text: "Want me to clip that?", options: ["y", "n"] });
    const q = await h.until(() => Object.values(modWatch.questions).find((x) => x.text === "Want me to clip that?"), "the relay to keep the question");
    await h.until(() => streamer.has("Want me to clip that?"), "the question on the dock");
    modWatch.send({ t: "withdraw", id: q.id });
    await h.until(() => !streamer.has("Want me to clip that?"), "the dock to drop it");
  },

  async "a private chat message reaches only the other person"(h) {
    const a = h.person("streamer");
    const b = h.person("mod1");
    const c = h.person("mod2");
    await h.friends(a, b);
    await h.friends(a, c);
    a.send({ t: "say", owner: "@mod1+streamer", text: "thanks for tonight" });
    await b.next("msg", (m) => m.m.text === "thanks for tonight");
    await h.wait(300);
    h.check(!c.seen("msg", (m) => m.m.text === "thanks for tonight"), "mod2 shouldn't see mod1's private chat");
  },

  async "someone who's only added one way can't ask yet, and shows as a request"(h) {
    const stranger = h.person("viewer9");
    const streamer = h.person("streamer");
    await Promise.all([stranger.ready, streamer.ready]);
    stranger.send({ t: "connect", login: "streamer" });
    await streamer.next("state", (m) => (m.requests || []).includes("viewer9"));
    stranger.send({ t: "ask", to: "streamer", text: "hello?", options: ["y"] });
    await stranger.next("error");
    h.check(!streamer.seen("q", (m) => m.q.text === "hello?"), "the streamer shouldn't get a question from someone they haven't added");
  },
};

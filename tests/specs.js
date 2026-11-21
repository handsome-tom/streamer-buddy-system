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
  await h.until(() => mod.$(".panel.mod .modfeed"), "the side panel's Mod section");
  return { streamer, mod, streamerWatch, modWatch };
}

const noErrors = (...panels) => {
  const errors = panels.flatMap((p) => p.errors);
  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
};

// With the allow list on, as on the real relay: "tom" is the owner.
const withAllowList = (fn) => Object.assign(fn, { relaySettings: { OWNER_LOGIN: "tom" } });
async function makeInvite(p) {
  await p.ready;
  p.send({ t: "invite" });
  return (await p.next("invite")).code;
}

export const tests = {
  async "the streamer's OBS dock and a mod's side panel both load and sign in"(h) {
    const { streamer, mod } = await streamerAndMod(h);
    noErrors(streamer, mod);
  },

  async "a mod asks, the question shows on the streamer's dock, and their Yes goes back"(h) {
    const { streamer, mod, modWatch } = await streamerAndMod(h);
    modWatch.send({ t: "ask", to: "streamer", text: "Can I run the poll now?", options: ["t", "y", "n"] });
    await h.until(() => streamer.has("Can I run the poll now?"), "the question on the streamer's dock");
    const yes = await h.until(() => streamer.$(".pill--answer.answer--y"), "a Yes button on the dock");
    yes.click();
    await h.until(() => Object.values(modWatch.questions).some((q) => q.text === "Can I run the poll now?" && q.answer?.code === "y"), "the relay to have the answer");
    await h.until(() => mod.$$(".modfeed__item").some((x) => x.textContent.includes("Can I run the poll now?") && /Yes/.test(x.querySelector(".modfeed__answer")?.textContent || "")), "Yes under the question in the mod's This stream feed");
    await h.until(() => !streamer.hasOnTop("Can I run the poll now?"), "the question to leave the streamer's bar");
    noErrors(streamer, mod);
  },

  async "Mod: no ask box; this stream's comments under the streamer's feed, ones over 30 minutes folded away; then DMs"(h) {
    const { mod, modWatch } = await streamerAndMod(h);
    h.check(!mod.$(".panel.mod .send__bar"), "no ask box in the Mod section");
    h.check(!mod.$(".panel.mod .log__head"), "no History in the Mod section");
    h.check(mod.$(".panel.mod .sv") && mod.$(".panel.mod .sv").compareDocumentPosition(mod.$(".panel.mod .modfeed")) & Node.DOCUMENT_POSITION_FOLLOWING, "the comments under the streamer's feed");
    // A question to the streamer, a note on a chat line now, and one from 40 minutes ago.
    modWatch.send({ t: "ask", to: "streamer", text: "Timeout the spammer?", options: ["t", "y", "n"] });
    modWatch.send({ t: "note", channel: "streamer", chatter: "sunchaser", chatterName: "SunChaser", text: "o7 everyone", body: "Keep an eye on this one" });
    modWatch.send({ t: "note", channel: "streamer", chatter: "bigdog15", chatterName: "BigDog15", text: "first!", body: "An old note", at: Date.now() - 40 * 60 * 1000 });
    const item = (text) => mod.$$(".modfeed__list:not(.modfeed__list--earlier) .modfeed__item").find((x) => x.textContent.includes(text));
    await h.until(() => item("Timeout the spammer?") && /Waiting for/.test(item("Timeout the spammer?").textContent), "the question in the feed, waiting");
    await h.until(() => item("Keep an eye on this one") && /SunChaser/.test(item("Keep an eye on this one").textContent), "the note in the feed, with its chat line");
    const fold = await h.until(() => mod.$(".modfeed__fold"), "Earlier this stream, for the old note");
    h.check(/Earlier this stream · 1/.test(fold.textContent) && !item("An old note"), "the old note folded away");
    fold.click();
    await h.until(() => mod.$$(".modfeed__list--earlier .modfeed__item").some((x) => x.textContent.includes("An old note")), "the old note there to look back at");
    // DMs: the streamer, under the comments.
    const dm = await h.until(() => mod.$(".moddms .moddms__row--streamer"), "the streamer under Active mods");
    dm.click();
    await h.until(() => mod.$(".chat--dm"), "the DMs with the streamer");
    noErrors(mod);
  },

  async "Active mods: connected mods first, ringed by how long ago they chatted, the quiet ones grayed; mods in chat you aren't connected with underneath"(h) {
    const { mod, modWatch } = await streamerAndMod(h);
    const chatty = h.person("mod2");
    const quiet = h.person("mod3");
    await h.friends(modWatch, chatty);
    await h.friends(modWatch, quiet);
    chatty.send({ t: "modfor", list: ["streamer"] });
    quiet.send({ t: "modfor", list: ["streamer"] });
    // What the extension's chatmods.js says: mod2 chatted 2 minutes ago, a stranger 15.
    const now = Date.now();
    mod.win.postMessage({ t: "ext-chatmods", channel: "streamer", mods: { mod2: now - 2 * 60000, stranger9: now - 15 * 60000 } }, location.origin);
    await h.until(() => mod.$(".moddms .moddms__row--stranger"), "the stranger under Active mods");
    const label = mod.$(".moddms > .mod__label")?.textContent;
    h.check(/Active mods/i.test(label), `the heading says Active mods (it says ${label})`);
    const rows = () => mod.$$(".moddms__row").map((r) => r.querySelector(".moddms__name").textContent);
    await h.until(() => rows().includes("mod3"), "mod3 listed even though they haven't chatted");
    h.check(JSON.stringify(rows()) === JSON.stringify(["streamer", "mod2", "mod3", "stranger9"]), `streamer, then connected mods (in chat first), then the stranger: ${rows()}`);
    const row = (n) => mod.$$(".moddms__row").find((r) => r.querySelector(".moddms__name").textContent === n);
    h.check(row("mod2").querySelector(".moddms__face--5") && !row("mod2").classList.contains("moddms__row--away"), "mod2 has a green ring");
    h.check(row("mod3").classList.contains("moddms__row--away") && !row("mod3").querySelector(".moddms__face--ring"), "mod3 grayed, no ring");
    h.check(row("stranger9").querySelector(".moddms__face--20"), "the stranger has a yellow ring");
    h.check(!/find ?my ?friends/i.test(mod.$(".moddms").innerText + mod.$$(".moddms__row").map((r) => r.title).join(" ")), "nothing mentions FindMyFriends");
    noErrors(mod);
  },

  async "the streamer asks from the bar and the mod's OK goes back"(h) {
    const { streamer, mod, streamerWatch } = await streamerAndMod(h);
    h.typeAndSend(streamer.$("#quickText"), "Can you post the Discord link?");
    await h.until(() => mod.has("Can you post the Discord link?"), "the question in the mod's panel");
    (await h.until(() => mod.$(".answer--o"), "an OK button in the mod's panel")).click();
    await h.until(() => Object.values(streamerWatch.questions).some((q) => q.text === "Can you post the Discord link?" && q.answer?.code === "o"), "the streamer to get OK");
    noErrors(streamer, mod);
  },

  async "the streamer's dock shows what's come in one big card at a time, with arrows to step through"(h) {
    const { streamer, mod, modWatch } = await streamerAndMod(h);
    modWatch.send({ t: "ask", to: "streamer", text: "First question?", options: ["t", "y", "n"] });
    await h.until(() => streamer.has("First question?"), "the first question on the dock");
    modWatch.send({ t: "ask", to: "streamer", text: "Second question?", options: ["t", "y", "n"] });
    await h.until(() => streamer.$(".slot__count")?.textContent.endsWith("/2"), "two cards in the slot");
    h.check(streamer.$$(".slot .peek--on").length === 2, "each question should be its own card");
    h.check(streamer.$(".slotwrap--many .slot__arrow--next"), "arrows should show with more than one");
    const before = streamer.$(".slot__count").textContent;
    streamer.$(".slot__arrow--next").click();
    await h.until(() => streamer.$(".slot__count").textContent !== before, "the arrow to step to the other card");
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
    await h.until(() => !streamer.hasOnTop("Timeout the spammer?"), "the dock to clear it");
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

  async "a secret chat note reaches the writer's network and the channel's mods, never the streamer"(h) {
    const mod = h.person("mod1");
    const other = h.person("mod2");
    const streamer = h.person("streamer");
    await h.friends(mod, streamer);
    await h.friends(other, streamer);
    h.check((mod.state.features || []).includes("secretNotes"), "the relay should say it can do secret notes");
    mod.send({ t: "note", channel: "streamer", chatter: "viewer1", chatterName: "Viewer1", text: "hello chat", body: "Watch this one, they were banned last week", secret: true });
    const { n } = await other.next("note", (m) => m.n.body.startsWith("Watch this one"));
    h.check(n.secret, "it should arrive marked secret");
    await h.until(() => mod.seen("note", (m) => m.n.id === n.id), "the writer to get it back too");
    mod.send({ t: "note", channel: "streamer", chatter: "viewer1", chatterName: "Viewer1", text: "hello chat", body: "A normal note" });
    await streamer.next("note", (m) => m.n.body === "A normal note");
    h.check(!streamer.seen("note", (m) => m.n.id === n.id), "the streamer should never get the secret note");
    streamer.send({ t: "notes", channel: "streamer", from: Date.now() - 60000, to: Date.now() + 5000 });
    const { list } = await streamer.next("notes");
    h.check(list.length === 1 && list[0].body === "A normal note", `the streamer's catch-up should leave the secret note out, got: ${list.map((x) => x.body)}`);
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

  async "quick info and a !vanish note stick at the top of chat once they scroll up, the !vanish one only briefly"(h) {
    const { streamer, modWatch } = await streamerAndMod(h);
    await h.until(() => streamer.$(".oc-line"), "custom chat to start");
    modWatch.send({ t: "flash", kind: "info", to: "streamer", text: "Ad in 2" });
    modWatch.send({ t: "flash", kind: "love", to: "streamer", text: "You're doing great" });
    await h.until(() => streamer.$(".oc-mod--love:not(.oc-mod--stuck)") && streamer.$(".oc-mod--info:not(.oc-mod--stuck)"), "both lines in chat");
    await h.wait(400);
    for (let i = 0; i < 60; i++) h.pretendTwitch.say(`chatter${i % 5}`, `filler line ${i} to push things up`);
    const stuck = (k) => streamer.$(`.oc-stuck .oc-mod--${k}`);
    await h.until(() => stuck("info") && stuck("love"), "both stuck at the top once scrolled up");
    await h.wait(7000);
    h.check(!stuck("love"), "the !vanish note should be gone from the top after 6 seconds");
    h.check(stuck("info"), "quick info should still be at the top (it stays 40 seconds)");
    // Seen: off the top, and its line carries on in chat marked Seen.
    stuck("info").querySelector(".oc-mod__act--seen").click();
    await h.until(() => !stuck("info"), "quick info to leave the top once it's Seen");
    h.check(/Seen/.test(streamer.$(".oc-mod--info:not(.oc-mod--stuck)")?.textContent || ""), "its line still in chat, marked Seen");
    // ×: another one goes off the screen altogether, top and chat both.
    modWatch.send({ t: "flash", kind: "info", to: "streamer", text: "Raid incoming" });
    await h.until(() => streamer.$$(".oc-mod--info:not(.oc-mod--stuck)").some((l) => l.textContent.includes("Raid incoming")), "the second quick info in chat");
    await h.wait(400);
    for (let i = 0; i < 60; i++) h.pretendTwitch.say(`chatter${i % 5}`, `more filler ${i}`);
    await h.until(() => stuck("info"), "the second one stuck at the top");
    stuck("info").querySelector(".oc-mod__act--dismiss").click();
    await h.until(() => !stuck("info") && !streamer.$$(".oc-mod--info").some((l) => l.textContent.includes("Raid incoming")), "× to take it off the top and out of chat");
    noErrors(streamer);
  },

  async "questions and quick info sent in a channel's chat come back in its VOD for the two of them, unless x'd out; !vanish never does"(h) {
    const s = h.person("streamer");
    const m = h.person("mod1");
    await h.friends(s, m);
    const t0 = Date.now() - 1000;
    const where = { channel: "streamer", anchor: { chatter: "viewer1", chatterName: "Viewer1", text: "gg that was close" } };
    m.send({ t: "ask", to: "streamer", text: "Raid after this?", options: ["t", "y", "n", "m"], ...where });
    const { q: q1 } = await s.next("q", (x) => x.q.text === "Raid after this?");
    m.send({ t: "ask", to: "streamer", text: "Drop this one?", options: ["t", "y", "n", "m"], ...where });
    const { q: q2 } = await s.next("q", (x) => x.q.text === "Drop this one?");
    m.send({ t: "flash", kind: "info", to: "streamer", text: "Ad in 2", ...where });
    await s.next("flash", (x) => x.f.text === "Ad in 2");
    m.send({ t: "flash", kind: "love", to: "streamer", text: "ur great", ...where });
    await s.next("flash", (x) => x.f.text === "ur great");
    s.send({ t: "answer", id: q1.id, code: "y" });
    await m.next("q", (x) => x.q.id === q1.id && x.q.answer);
    s.send({ t: "dismiss", id: q2.id });
    await m.next("q", (x) => x.q.id === q2.id && x.q.dismissed);
    const log = async (p, asks = true) => {
      p.send({ t: "notes", channel: "streamer", from: t0, to: Date.now() + 1000, ...(asks ? { log: true } : {}) });
      return (await p.next("notes")).list;
    };
    const list = await log(s);
    h.check(list.map((n) => n.body).sort().join() === "Ad in 2,Raid after this?", `the VOD should have the question and the quick info, got: ${list.map((n) => n.body).join(", ")}`);
    const raid = list.find((n) => n.body === "Raid after this?");
    h.check(raid.kind === "ask" && raid.answers?.streamer?.code === "y" && raid.chatter === "viewer1" && raid.text === "gg that was close", "the question keeps its answer and its moment in chat");
    h.check((await log(m)).length === 2, "the mod who sent them sees them too");
    h.check((await log(s, false)).length === 0, "a page that doesn't ask for the log (an older one) gets none of it");
    s.send({ t: "unlog", id: list.find((n) => n.kind === "info").fid });
    await h.wait(200);
    h.check(!(await log(s)).some((n) => n.kind === "info"), "the streamer's X on quick info takes it out of the VOD");
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
    await h.until(() => !streamer.hasOnTop("Want me to clip that?"), "the dock to drop it");
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

  async "Messages calls each group chat by its group's name, and lists who's online first"(h) {
    const streamer = h.person("streamer");
    const mod1 = h.person("mod1");
    const mod2 = h.person("mod2");
    const mod3 = h.person("mod3");
    await h.friends(streamer, mod1);
    await h.friends(mod1, mod2);
    await h.friends(mod1, mod3);
    // The streamer's group chat for their "Mod squad", with mod1 in it.
    streamer.send({ t: "tag", tag: "Mod squad", login: "mod1", on: true });
    await streamer.next("state", (m) => m.tags?.["Mod squad"]?.includes("mod1"));
    streamer.send({ t: "room", tag: "Mod squad" });
    await mod1.next("state", (m) => (m.rooms || []).some((r) => !r.direct && r.tag === "Mod squad"));
    mod3.close(); // mod3 goes offline
    await mod1.next("state", (m) => m.connections?.some((c) => c.login === "mod3" && !c.online));

    const panel = await h.panel("mod1", "ext");
    (await h.until(() => panel.$("#msgBtn:not([hidden])"), "the Messages button")).click();
    const group = await h.until(() => panel.$$(".msgs__row").find((r) => r.textContent.includes("Mod squad")), "the Mod squad group chat");
    const groupName = group.querySelector(".msgs__name")?.textContent;
    h.check(groupName === "Mod squad", `the group chat should be called Mod squad, not "${groupName}"`);
    h.check(!/room/i.test(panel.$("#main").innerText), "Messages shouldn't say 'room' anywhere");
    const online = panel.$$(".msgs__facename").map((n) => n.textContent);
    h.check(online.includes("mod2") && online.includes("streamer") && !online.includes("mod3"), `Online now should be streamer and mod2, got: ${online}`);
    const direct = [...panel.$$(".msgs__list")[1].querySelectorAll(".msgs__name")].map((n) => n.firstChild.textContent);
    h.check(direct.length === 3 && direct.at(-1) === "mod3", `offline mod3 should come last in Direct messages, got: ${direct}`);

    // Connections: the people (online first) come before groups and adding people.
    panel.$("#peopleBtn").click();
    const first = await h.until(() => panel.$(".cx .cx__section .cx__label"), "the first section in Connections");
    h.check(first.textContent === "Online · 2", `Connections should open with who's online, got: ${first.textContent}`);
    h.check(first.compareDocumentPosition(panel.$(".cx__add")) & Node.DOCUMENT_POSITION_FOLLOWING, "Add people should come after the people");
    noErrors(panel);
  },

  "Messages opens on your profile and your Top 8: the owner always first, then your first seven connections in order": withAllowList(async (h) => {
    const tom = h.person("tom");
    await tom.ready;
    const mods = Array.from({ length: 8 }, (_, i) => `mod${i + 1}`);
    for (const l of ["streamer", ...mods]) tom.send({ t: "allow", login: l, on: true });
    await tom.next("state", (m) => (m.allowed || []).length >= 9);
    const streamer = h.person("streamer");
    for (const l of mods) await h.friends(streamer, h.person(l));
    const panel = await h.panel("streamer", "ext");
    (await h.until(() => panel.$("#msgBtn:not([hidden])"), "the Messages button")).click();
    await h.until(() => panel.$$(".fspace__friend").length === 8, "eight people in the Top 8");
    h.check(panel.$(".myspace__name")?.textContent === "streamer", "the profile at the top should be yours");
    h.check(/Online Now!/.test(panel.$(".myspace__status")?.textContent || ""), "your profile should say Online Now!");
    h.check(!/online since/i.test(panel.$(".myspace").innerText), "your profile shouldn't say when you came online");
    const top = panel.$$(".fspace__name").map((n) => n.textContent);
    h.check(top.join() === ["tom", ...mods.slice(0, 7)].join(), `the Top 8 should be the owner, then mod1 to mod7 in the order added, got: ${top}`);
    h.check(streamer.connectedTo("tom"), "the owner should still be one of your connections");
    (await h.until(() => panel.$$(".fspace__all").find((b) => b.textContent === "Edit"), "the Edit button")).click();
    await h.until(() => panel.$(".fspace--editing"), "editing the Top 8");
    h.check(panel.$$(".fspace__friend").length === 8 && panel.$$(".fspace__x").length === 7, "everyone but the owner can be taken out of your Top 8");
    h.check(!panel.$$(".fspace__free").length, "a full Top 8 has no free spots");
    h.check(panel.$$(".msgs__sechead").some((s) => /Direct messages/.test(s.textContent)), "the usual lists should still be under it");
    noErrors(panel);
  }),

  async "joining asks streamer, mod, both or neither; both picks mostly-mod; the profile changes it and connections see it"(h) {
    const friend = h.person("mod2");
    const meWatch = h.person("mod1");
    await h.friends(friend, meWatch);
    const panel = await h.panel("mod1", "ext", "askroles");
    await h.until(() => panel.$(".roles__choice[data-role='both']"), "the welcome question");
    h.check(panel.$(".roles .agree__go").disabled, "Continue waits for a choice");
    panel.$(".roles__choice[data-role='both']").click();
    await h.until(() => panel.$(".roles__mostly:not([hidden])"), "Mostly known as, for both");
    h.check(panel.$(".roles__main[aria-pressed='true']")?.dataset.main === "mod", "mod is the default main role");
    panel.$(".roles .agree__go").click();
    await h.until(() => !panel.$(".roles"), "the question to close");
    await h.until(() => friend.state?.connections?.find((c) => c.login === "mod1")?.roles?.main === "mod", "mod2 to see mod1 as mainly a mod");
    h.check(friend.state.connections.find((c) => c.login === "mod1").roles.streamer, "and as a streamer too");
    (await h.until(() => panel.$("#msgBtn:not([hidden])"), "the Messages button")).click();
    const streamerChip = await h.until(() => panel.$(".myspace__role[data-role='streamer'][aria-pressed='true']"), "Streamer on, on the profile");
    h.check(panel.$(".myspace__known")?.textContent === "Mod", "Known for: Mod");
    streamerChip.click();
    await h.until(() => friend.state?.connections?.find((c) => c.login === "mod1")?.roles?.streamer === false, "turning Streamer off to reach the relay");
    await h.until(() => !panel.$(".myspace__known"), "Known for to go once you're only a mod");
    noErrors(panel);
  },

  async "DM chime: the extension's quiet listener hears DMs (with your status) without making you look online; the side panel reports unread DMs and has the switch"(h) {
    const mod1 = h.person("mod1");
    const mod2 = h.person("mod2");
    await h.friends(mod1, mod2);
    mod1.send({ t: "status", status: "idle" });
    await h.until(() => mod2.state?.connections?.find((c) => c.login === "mod1")?.idle, "mod2 to see mod1 idle");
    mod1.close();
    await h.until(() => mod2.state?.connections?.find((c) => c.login === "mod1")?.online === false, "mod1 to go offline");
    const ear = h.listener("mod1");
    await h.until(() => ear.got.find((m) => m.t === "listening"), "the listener to be let in");
    h.check(ear.got[0].status === "idle", "the listener should hear your status");
    await h.wait(300);
    h.check(mod2.state.connections.find((c) => c.login === "mod1").online === false, "a listener mustn't make you show as online");
    mod2.send({ t: "say", owner: "@mod1+mod2", text: "you there?" });
    const dm = await h.until(() => ear.got.find((m) => m.t === "dm"), "the listener to hear the DM");
    h.check(dm.from === "mod2" && dm.owner === "@mod1+mod2" && dm.status === "idle" && dm.at > 0, "dm carries who, which room, when, and your status");
    h.check(!dm.text, "the listener doesn't need the words");
    mod2.send({ t: "say", owner: "mod2", text: "not a DM" });
    await h.wait(200);
    h.check(ear.got.filter((m) => m.t === "dm").length === 1, "only direct messages reach the listener");
    ear.send({ t: "status", status: "online" });
    await h.wait(200);
    h.check(mod2.state.connections.find((c) => c.login === "mod1").online === false, "a listener can't change anything");

    // The side panel tells the extension how many DMs are unread, and shows the switch once it answers.
    const told = [];
    const hear = (e) => String(e.data?.t).startsWith("ext-dm") && told.push(e.data);
    addEventListener("message", hear);
    try {
      const panel = await h.panel("mod1", "ext");
      await h.until(() => told.find((m) => m.t === "ext-dmchime-get"), "the panel to ask about the chime");
      await h.until(() => told.find((m) => m.t === "ext-dms" && m.unread === 1), "the panel to report one unread DM");
      panel.win.postMessage({ t: "ext-dmchime", on: true }, "*");
      (await h.until(() => panel.$("#msgBtn:not([hidden])"), "the Messages button")).click();
      const sw = await h.until(() => panel.$(".myspace__chime"), "the DM chime switch on the profile");
      h.check(sw.getAttribute("aria-pressed") === "true" && sw.textContent === "On", "the chime starts on");
      sw.click();
      await h.until(() => told.find((m) => m.t === "ext-dmchime-set" && m.on === false), "silencing to reach the extension");
      noErrors(panel);
    } finally {
      removeEventListener("message", hear);
    }
  },

  async "groups live in Messages, not Connections: make one, open its page, start its group chat"(h) {
    const mod1 = h.person("mod1");
    const mod2 = h.person("mod2");
    const mod3 = h.person("mod3");
    await h.friends(mod1, mod2);
    await h.friends(mod1, mod3);
    const panel = await h.panel("mod1", "ext");
    (await h.until(() => panel.$("#peopleBtn:not([hidden])"), "the Connections button")).click();
    await h.until(() => panel.$(".cx .cx__section"), "Connections");
    h.check(!panel.$(".cx__group, .cx__groupsec, .people__plus, .tagchip") && !/Groups/i.test(panel.$("#main").innerText), "the side panel's Connections shouldn't have groups in it");

    // Messages: + New, a name, tick mod2, Make group.
    (await h.until(() => panel.$("#msgBtn:not([hidden])"), "the Messages button")).click();
    (await h.until(() => panel.$$(".msgs__new").find((b) => b.textContent === "+ New"), "+ New in Messages")).click();
    const name = await h.until(() => panel.$('[data-key="new-group"]'), "the new group's name box");
    name.value = "Night crew";
    name.dispatchEvent(new Event("input"));
    panel.$$(".msgs__pickrow").find((r) => r.textContent.includes("mod2")).click();
    (await h.until(() => panel.$(".msgs__make"), "Make group")).click();
    await h.until(() => mod1.state?.tags?.["Night crew"]?.includes("mod2"), "the relay to have the Night crew group");

    // Its page, as a list: start its group chat, Ask everyone, who's in it.
    const title = await h.until(() => panel.$(".grp .dm__name"), "the group's page");
    h.check(title.textContent === "Night crew", `the group's page should be Night crew, got: ${title.textContent}`);
    const acts = panel.$$(".grp__acts .msgs__row");
    h.check(acts.some((r) => r.textContent.includes("Ask everyone")), "the group's page should have Ask everyone");
    const start = acts.find((r) => r.textContent.includes("Start a group chat"));
    h.check(start, "the group's page should offer to start its group chat");
    start.click();
    await h.until(() => (mod2.state?.rooms || []).some((r) => !r.direct && r.owner === "mod1" && r.tag === "Night crew"), "mod2 to be in the Night crew group chat");
    h.check(!(mod3.state?.rooms || []).some((r) => !r.direct && r.owner === "mod1"), "mod3 isn't in Night crew, so shouldn't be in its chat");
    await h.until(() => panel.$(".dm__head--link"), "the group chat's top, which opens the group's page");

    // Back in Messages, the group's row opens its chat now.
    panel.$("#msgBtn").click();
    (await h.until(() => panel.$$(".msgs__groups .msgs__row").find((r) => r.textContent.includes("Night crew")), "Night crew in Messages")).click();
    await h.until(() => panel.$(".chat__form"), "the Night crew group chat");
    noErrors(panel);
  },

  async "the side panel's top bar stays on your streamers, who show in purple; a group chat can leave Messages and come back"(h) {
    const streamer = h.person("streamer");
    const mod1 = h.person("mod1");
    await h.friends(streamer, mod1);
    streamer.send({ t: "tag", tag: "Mod squad", login: "mod1", on: true });
    await streamer.next("state", (m) => m.tags?.["Mod squad"]?.includes("mod1"));
    streamer.send({ t: "room", tag: "Mod squad" });
    await h.until(() => (mod1.state?.rooms || []).some((r) => !r.direct && r.tag === "Mod squad"), "mod1 to be in the Mod squad group chat");

    const panel = await h.panel("mod1", "ext", "&modfor=streamer");
    (await h.until(() => panel.$("#msgBtn:not([hidden])"), "the Messages button")).click();
    await h.until(() => panel.$(".msgs__face"), "Online now");
    h.check(panel.$("#dots.dots--mod"), "in Messages, the top bar should still be your streamers");
    const face = panel.$$(".msgs__face").find((b) => b.textContent.includes("streamer"));
    h.check(face?.classList.contains("rel--streamer") && face.querySelector(".rank--live"), "your streamer's face should be purple, with the camera");

    // ⋯ on the group chat, Remove from Messages: gone, with Show hidden to bring it back.
    const item = await h.until(() => panel.$$(".msgs__item").find((i) => i.textContent.includes("Mod squad")), "Mod squad in Groups");
    item.querySelector(".msgs__more").click();
    const remove = await h.until(() => panel.$$(".grp__ends .msgs__row").find((r) => r.textContent.includes("Remove from Messages")), "Remove from Messages on its page");
    remove.click();
    const show = await h.until(() => panel.$$(".msgs__groups .msgs__row").find((r) => r.textContent.includes("Show hidden")), "Show hidden in Groups");
    h.check(!panel.$$(".msgs__groups .msgs__name").some((n) => n.textContent === "Mod squad"), "Mod squad should be out of Messages");
    show.click();
    await h.until(() => panel.$$(".msgs__groups .msgs__name").some((n) => n.textContent === "Mod squad"), "Mod squad back in Messages");
    noErrors(panel);
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

  // ----- Invite links -----------------------------------------------------------------------

  async "opening an invite link and signing in connects both people at once"(h) {
    const streamer = h.person("streamer");
    const code = await makeInvite(streamer);
    const newMod = await h.panel("newmod", "page", `invite=${code}`);
    await h.until(() => newMod.has("You're connected to streamer!"), "the welcome on the new mod's page");
    await h.until(() => streamer.connectedTo("newmod"), "the streamer to have newmod, both ways");
    await h.until(() => streamer.seen("invited", (m) => m.login === "newmod"), "the streamer to hear the link was used");
    h.check(!newMod.win.location.search.includes("invite="), "the link's code should leave the address once used");
    noErrors(newMod);
  },

  async "Connections makes an invite link to copy"(h) {
    const dock = await h.panel("streamer", "ext");
    (await h.until(() => dock.$("#peopleBtn:not([hidden])"), "the Connections button")).click();
    (await h.until(() => dock.$(".cx__invitego"), "the invite button")).click();
    const field = await h.until(() => dock.$(".cx__invitelink"), "the invite link");
    h.check(/\?invite=[a-z2-9]{10}$/.test(field.value), `odd invite link: ${field.value}`);
    noErrors(dock);
  },

  async "an invite link works only once, and not on yourself"(h) {
    const streamer = h.person("streamer");
    const code = await makeInvite(streamer);
    streamer.send({ t: "redeem", code });
    const own = await streamer.next("error", (m) => m.why === "invite");
    h.check(/your own/.test(own.detail), `expected the "own link" message, got: ${own.detail}`);
    const first = h.person("mod1");
    await first.ready;
    first.send({ t: "redeem", code });
    await first.next("redeemed", (m) => m.from === "streamer");
    const second = h.person("mod2");
    await second.ready;
    second.send({ t: "redeem", code });
    const used = await second.next("error", (m) => m.why === "invite");
    h.check(/already been used/.test(used.detail), `expected "already been used", got: ${used.detail}`);
    h.check(!streamer.connectedTo("mod2"), "mod2 shouldn't be connected");
  },

  "with the allow list on, someone invited waits for the owner, then the link still works": withAllowList(async (h) => {
    const tom = h.person("tom");
    await tom.ready;
    tom.send({ t: "allow", login: "streamer", on: true });
    await tom.next("state", (m) => (m.allowed || []).some((a) => (a.login || a) === "streamer"));
    const streamer = h.person("streamer");
    const code = await makeInvite(streamer);
    const turnedAway = h.person("newbie", { invite: code });
    await h.until(() => turnedAway.closedWith === 4003, "newbie to be turned away (not on the allow list)");
    await h.until(() => (tom.state.asking || []).some((a) => a.login === "newbie" && a.by === "streamer"), "the owner to see newbie, invited by streamer");
    tom.send({ t: "allow", login: "newbie", on: true });
    const newbie = h.person("newbie", { invite: code });
    await newbie.ready;
    newbie.send({ t: "redeem", code });
    await newbie.next("redeemed");
    await h.until(() => streamer.connectedTo("newbie"), "streamer and newbie to be connected");
  }),

  "an invite link can't go past a full Top 8": withAllowList(async (h) => {
    const tom = h.person("tom");
    await tom.ready;
    const logins = ["streamer", "late", ...Array.from({ length: 8 }, (_, i) => `mod${i + 1}`)];
    for (const l of logins) tom.send({ t: "allow", login: l, on: true });
    await tom.next("state", (m) => (m.allowed || []).length >= logins.length);
    const streamer = h.person("streamer");
    const mods = Array.from({ length: 8 }, (_, i) => h.person(`mod${i + 1}`));
    for (const m of mods) await h.friends(streamer, m);
    const code = await makeInvite(streamer);
    const late = h.person("late");
    await late.ready;
    late.send({ t: "redeem", code });
    const full = await late.next("error", (m) => m.why === "invite");
    h.check(/full/.test(full.detail), `expected a "list is full" message, got: ${full.detail}`);
    h.check(!streamer.connectedTo("late"), "late shouldn't be connected past the Top 8");
  }),

  // ----- Feedback and problem reports -------------------------------------------------------

  "feedback sent from Settings reaches the owner, and only the owner": withAllowList(async (h) => {
    const tom = h.person("tom");
    await tom.ready;
    tom.send({ t: "allow", login: "streamer", on: true });
    await tom.next("state", (m) => (m.allowed || []).some((a) => (a.login || a) === "streamer"));
    const dock = await h.panel("streamer", "ext");
    // Signed in first: Send feedback is only in Settings once you are.
    await h.until(() => dock.$("#peopleBtn:not([hidden])"), "the panel to sign in");
    (await h.until(() => dock.$("#settingsBtn"), "the Settings button")).click();
    (await h.until(() => dock.$(".set__feedback"), "Send feedback in Settings")).click();
    const box = await h.until(() => dock.$(".feedback__text"), "the feedback box");
    box.value = "The nudge sound is too quiet";
    box.form.requestSubmit();
    await h.until(() => dock.has("Thanks!"), "the thank-you");
    await h.until(() => tom.state.reports === 1, "the owner to see 1 new report");
    tom.send({ t: "reports" });
    const { feedback } = await tom.next("reports");
    h.check(feedback[0]?.text === "The nudge sound is too quiet" && feedback[0]?.from === "streamer", `unexpected feedback: ${JSON.stringify(feedback[0])}`);
    // Someone else asking for the reports gets nothing.
    const streamer = h.person("streamer");
    await streamer.ready;
    streamer.send({ t: "reports" });
    await h.wait(400);
    h.check(!streamer.seen("reports"), "only the owner should get the reports");
    // And the owner's own Connections shows it.
    const tomsPanel = await h.panel("tom", "ext");
    (await h.until(() => tomsPanel.$("#peopleBtn:not([hidden])"), "the owner's Connections button")).click();
    (await h.until(() => tomsPanel.$(".cx__reports .cx__allowhead"), "the Feedback & problems card")).click();
    await h.until(() => tomsPanel.has("The nudge sound is too quiet"), "the feedback in the owner's panel");
    noErrors(dock, tomsPanel);
  }),

  "a tester request from the website reaches the owner's log, and only the owner": withAllowList(async (h) => {
    const tom = h.person("tom");
    await tom.ready;
    tom.send({ t: "allow", login: "streamer", on: true });
    await tom.next("state", (m) => (m.allowed || []).some((a) => (a.login || a) === "streamer"));
    const streamer = h.person("streamer");
    await streamer.ready;
    const ok = await h.relayPost("/api/join", { name: "@INeverDie", role: "Stream and mod" });
    h.check(ok.status === 200, `the request should be saved (got ${ok.status})`);
    const bad = await h.relayPost("/api/join", { name: "x", role: "Hacker" });
    h.check(bad.status === 400, "a made-up role should be turned away");
    const elsewhere = await h.relayPost("/api/join", { name: "x", role: "Mod only" }, "https://example.com");
    h.check(elsewhere.status === 403, "a request from another website should be turned away");
    await h.until(() => tom.state.reports === 1, "the owner to see 1 new item");
    tom.send({ t: "reports" });
    const { joins } = await tom.next("reports");
    h.check(joins.length === 1 && joins[0].name === "INeverDie" && joins[0].role === "Stream and mod", "the owner should get the request, @ taken off");
    streamer.send({ t: "reports" });
    await new Promise((r) => setTimeout(r, 300));
    h.check(!streamer.seen("reports"), "only the owner should get the requests");
    const tomsPanel = await h.panel("tom", "ext");
    (await h.until(() => tomsPanel.$("#peopleBtn:not([hidden])"), "the owner's Connections button")).click();
    (await h.until(() => tomsPanel.$(".cx__reports .cx__allowhead"), "the Testers, feedback & problems card")).click();
    await h.until(() => tomsPanel.has("INeverDie · Stream and mod"), "the request in the owner's panel");
    noErrors(tomsPanel);
  }),

  "an error in the dock is reported to the owner once, without what anyone typed": withAllowList(async (h) => {
    const tom = h.person("tom");
    await tom.ready;
    tom.send({ t: "allow", login: "streamer", on: true });
    await tom.next("state", (m) => (m.allowed || []).some((a) => (a.login || a) === "streamer"));
    const dock = await h.panel("streamer", "obs");
    await h.until(() => dock.$("#peopleBtn:not([hidden])"), "the dock to sign in");
    await h.wait(300);
    const boom = () => dock.win.dispatchEvent(new dock.win.ErrorEvent("error", { message: "TypeError: test boom", filename: "https://example.com/dock.js?v=341", lineno: 12, colno: 34 }));
    boom();
    boom(); // the same error again: reported once
    dock.win.dispatchEvent(new dock.win.ErrorEvent("error", { message: "someone else's script", filename: "https://example.com/other.js", lineno: 1, colno: 1 }));
    await h.until(() => tom.state.reports >= 1, "the owner to see a new problem");
    tom.send({ t: "reports" });
    const { oops } = await tom.next("reports");
    h.check(oops.length === 1, `expected 1 kind of problem, got ${oops.length}: ${JSON.stringify(oops)}`);
    h.check(oops[0].msg === "TypeError: test boom" && oops[0].where === "dock.js:12:34" && oops[0].count === 1 && oops[0].logins.join() === "streamer", `unexpected report: ${JSON.stringify(oops[0])}`);
  }),

  // ----- Custom chat ------------------------------------------------------------------------

  async "a raid card shows who and how many first, then followers, connection, their bio, in common, and since when it counted"(h) {
    const dock = await h.panel("streamer", "obs");
    await h.until(() => dock.$(".oc-line"), "custom chat to start");
    await h.wait(500);
    const { from, count } = h.pretendTwitch.raid();
    const card = await h.until(() => dock.$(".oc-notice--raid"), "the raid card");
    h.check(card.querySelector(".oc-raid__name")?.textContent === from, "the raider's name");
    h.check(card.querySelector(".oc-raid__count b")?.textContent === count.toLocaleString(), "the raider count, big");
    await h.until(() => /12\.4K followers/.test(card.querySelector(".oc-raid__sub")?.textContent || ""), "the follower count under the name");
    h.check(/Minecraft/.test(card.querySelector(".oc-raid__sub").textContent), "what they stream, under the name");
    const labels = [...card.querySelectorAll(".oc-raid__label")].map((l) => l.textContent);
    h.check(labels.join() === "Connection,In common", `sections in order, got: ${labels.join(", ")}`);
    h.check(/Follows you/.test(card.textContent) && /Raided you 2×/.test(card.textContent) && card.textContent.includes("Chatted here · 14 messages"), "connection: follows, raided and chatted before");
    h.check(/Raids and chat counted since .+, while custom chat was open\./.test(card.querySelector(".oc-raid__note")?.textContent || ""), "the card should say since when raids and chat were counted");
    const parts = [...card.querySelector(".oc-raid__about").children].map((c) => c.className);
    h.check(parts.join() === "oc-raid__sec,oc-raid__bio,oc-raid__sec,oc-raid__note oc-raid__note--foot", `connection, bio, in common, then the counted-since note last, got: ${parts.join(", ")}`);
    noErrors(dock);
  },

  async "Mod tools: a mod refunds a StreamSpace reward, turns on slow mode, and a raid waits for the streamer's OK"(h) {
    const { streamer, mod } = await streamerAndMod(h);
    await h.until(() => streamer.$(".oc-line"), "custom chat to start");
    const tools = await h.until(() => mod.$("#toolsBtn:not([hidden])"), "the sword (Mod tools) in the side panel's bar");
    const shown = [...tools.parentElement.children].filter((b) => !b.hidden && b.offsetWidth);
    h.check(shown[shown.indexOf(tools) - 1]?.id === "modBtn" && shown[shown.indexOf(tools) + 1]?.id === "msgBtn", "the sword sits between Mod and Messages");
    // A redemption of a reward made with StreamSpace (Hydrate!), then refunded from the panel.
    let r;
    for (let i = 0; i < 40 && (r = h.pretendTwitch.redeem()).title !== "Hydrate!"; i++) await h.wait(30);
    h.check(r.title === "Hydrate!", "the pretend Twitch to redeem Hydrate!");
    tools.click();
    // Each tool opens on a page of its own from the front page's round icons.
    const open = async (k) => {
      mod.$(".tools__back")?.click();
      (await h.until(() => mod.$(`.tools__tile[data-tool="${k}"]`), `the ${k} icon on Mod tools' front page`)).click();
      await h.until(() => mod.$(`.tools__page[data-tool="${k}"]`), `the ${k} page`);
    };
    await h.until(() => mod.$$(".tools__nowrow").some((x) => /new redemption/.test(x.textContent)), "the new redemption under Happening now");
    await open("points");
    const row = await h.until(() => mod.$$(".tools__red").find((x) => x.textContent.includes("Hydrate!") && x.querySelector(".tools__btn--refund")), "the redemption in Mod tools");
    row.querySelector(".tools__btn--refund").click();
    await h.until(() => /Refunded .*Hydrate!/.test(mod.$(".tools__said")?.textContent || ""), "the refund confirmed in the panel");
    await h.until(() => streamer.has("refunded"), "the refund noted in the streamer's chat");
    // Slow mode on.
    await open("modes");
    mod.$$(".tools__mode").find((b) => b.textContent.includes("Slow")).click();
    await h.until(() => mod.$$(".tools__mode").find((b) => b.textContent.includes("Slow"))?.getAttribute("aria-pressed") === "true", "slow mode shown on");
    // A raid: nothing happens until the streamer presses Raid.
    await open("raid");
    const field = mod.$(".tools__raid .tools__field");
    field.value = "lumpthegreen";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    mod.$(".tools__raid").requestSubmit();
    const ok = await h.until(() => streamer.$(".oc-mod--ask .oc-mod__act--y"), "Raid / Not now in the streamer's chat");
    h.check(!mod.$(".tools__raiding"), "no raid before the streamer OKs it");
    ok.click();
    await h.until(() => /Raiding lumpthegreen/.test(mod.$(".tools__raiding")?.textContent || ""), "the raid shown in the mod's panel");
    noErrors(streamer, mod);
  },

  async "More mod tools: a mod starts a poll, blocks a word and answers an unban request, and the mod log credits them"(h) {
    const { streamer, mod } = await streamerAndMod(h);
    await h.until(() => streamer.$(".oc-line"), "custom chat to start");
    (await h.until(() => mod.$("#toolsBtn:not([hidden])"), "the sword in the side panel's bar")).click();
    const type = (key, v) => { const i = mod.$(`[data-key="${key}"]`); i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); };
    const button = (re) => mod.$$(".tools button").find((b) => re.test(b.textContent.trim()));
    const open = async (k) => {
      mod.$(".tools__back")?.click();
      (await h.until(() => mod.$(`.tools__tile[data-tool="${k}"]`), `the ${k} icon on Mod tools' front page`)).click();
      await h.until(() => mod.$(`.tools__page[data-tool="${k}"]`), `the ${k} page`);
    };
    await open("safety");
    await h.until(() => mod.$$(".tools__chip").some((c) => c.textContent.includes("spoilers")), "the channel's blocked words");
    // A poll (then its front-page icon says it's running).
    await open("poll");
    type("pollQ", "Which boss next?");
    type("pollC1", "Margit");
    type("pollC2", "Godrick");
    await h.wait(100);
    button(/^Start poll$/).closest("form").requestSubmit();
    await h.until(() => mod.$$(".tools__bar").some((b) => b.textContent.includes("Godrick")), "the poll running in Mod tools");
    await h.until(() => streamer.has("started a poll"), "the poll noted in the streamer's chat");
    mod.$(".tools__back").click();
    await h.until(() => mod.$('.tools__tile[data-tool="poll"].tools__tile--live'), "the poll's icon marked running");
    // A blocked word.
    await open("safety");
    type("termAdd", "camping");
    button(/^Block$/).closest("form").requestSubmit();
    await h.until(() => mod.$$(".tools__chip").some((c) => c.textContent.includes("camping")), "the new blocked word");
    // The unban request waiting.
    await open("unbans");
    (await h.until(() => button(/^Unban$/), "the unban request")).click();
    await h.until(() => /Approved/.test(mod.$(".tools__said")?.textContent || ""), "the unban confirmed");
    // The mod log names the mod, not the streamer whose sign-in did it.
    await open("log");
    await h.until(() => mod.$$(".tools__logrow").some((l) => /mod1 blocked “camping”/.test(l.textContent)), "the mod log crediting the mod");
    noErrors(streamer, mod);
  },

  async "without the follower permission, the raid card says nothing about following (never a wrong no)"(h) {
    h.pretendTwitch.scopes(["user:read:chat", "user:write:chat", "user:read:emotes", "moderator:manage:banned_users", "moderator:manage:chat_messages", "moderator:manage:automod"]);
    const dock = await h.panel("streamer", "obs");
    await h.until(() => dock.$(".oc-line"), "custom chat to start");
    await h.wait(800);
    h.pretendTwitch.raid();
    const card = await h.until(() => dock.$(".oc-notice--raid"), "the raid card");
    await h.until(() => card.querySelector(".oc-raid__label"), "the card to fill in");
    await h.wait(300);
    h.check(!/follow you|Follows you/.test(card.textContent), `it shouldn't say anything about following: ${card.querySelector(".oc-raid__about")?.textContent}`);
    h.check(/followers/.test(card.querySelector(".oc-raid__sub")?.textContent || ""), "the follower count still shows (it needs no permission)");
  },

  // ----- The playground's pretend Twitch chat (StreamSpace's real chat scripts) --------------

  async "in the pretend Twitch chat, a Connections chat message and a note on a line can be replied to, and replies to replies too"(h) {
    const streamer = h.person("streamer");
    const mod = h.person("mod1");
    const mod2 = h.person("mod2");
    await h.friends(streamer, mod);
    await h.friends(streamer, mod2);
    await h.friends(mod, mod2);
    const tw = await h.panel("mod1", "twitch");
    h.pretendTwitch.say("hellofoxy", "first time here!");
    await h.until(() => [...tw.doc.querySelectorAll(".chat-line__message")].find((l) => l.textContent.includes("first time here!")), "the line in the pretend Twitch chat");
    await h.wait(300);
    const on = { chatter: "hellofoxy", chatterName: "hellofoxy", text: "first time here!" };
    const bubble = (body) => [...tw.doc.querySelectorAll(".tbc-note")].find((b) => b.querySelector(".tbc-note__body")?.textContent === body);
    const reply = async (to, body) => {
      const b = await h.until(() => bubble(to), `the note "${to}" in chat`);
      b.querySelector(".tbc-note__reply").click();
      const box = await h.until(() => tw.$(".tbc-notebox--reply"), "the reply box under it");
      h.check(box.previousElementSibling === b || box.previousElementSibling?.dataset.tbcRoot === b.dataset.tbcRoot, "the reply box sits under the note's thread");
      box.querySelector("textarea").value = body;
      box.requestSubmit();
    };
    // A Connections chat message from another mod: the reply is secret too, and answers it.
    mod2.send({ t: "note", secret: true, channel: "streamer", ...on, body: "anyone else lagging?" });
    const { n: parent } = await mod2.next("note", (x) => x.n.body === "anyone else lagging?");
    await reply("anyone else lagging?", "yeah a bit");
    const { n: r1 } = await mod2.next("note", (x) => x.n.body === "yeah a bit");
    h.check(r1.re === parent.id && r1.secret && r1.reFrom === "mod2" && r1.reBody === "anyone else lagging?", `the reply should answer it, secretly: ${JSON.stringify(r1)}`);
    const shown = await h.until(() => bubble("yeah a bit"), "the reply in chat");
    h.check(shown.classList.contains("tbc-note--reply") && /mod2: anyone else lagging\?/.test(shown.querySelector(".tbc-note__quote")?.textContent || ""), "the reply shows what it answers");
    h.check(shown.previousElementSibling === bubble("anyone else lagging?"), "the reply sits right under what it answers");
    // A reply to that reply.
    mod2.send({ t: "note", secret: true, channel: "streamer", ...on, body: "same", re: r1.id, reFrom: "mod1", reBody: "yeah a bit" });
    await h.until(() => bubble("same"), "the reply to the reply");
    h.check(bubble("same").previousElementSibling === shown, "a reply to a reply follows it in the thread");
    // A note on a line (not secret): its reply isn't secret either.
    mod2.send({ t: "note", channel: "streamer", ...on, body: "welcome them!" });
    await reply("welcome them!", "on it");
    const { n: r2 } = await mod2.next("note", (x) => x.n.body === "on it");
    h.check(!r2.secret && r2.reFrom === "mod2", "a reply to a note on a line goes to the same people as it");
    noErrors(tw);
  },

  async "in the pretend Twitch chat, StreamSpace's flag reaches the streamer and typing chats as the mod"(h) {
    const streamer = h.person("streamer");
    const mod = h.person("mod1");
    await h.friends(streamer, mod);
    const tw = await h.panel("mod1", "twitch");
    h.pretendTwitch.say("hellofoxy", "is this the right stream?");
    const line = await h.until(() => [...tw.doc.querySelectorAll(".chat-line__message")].find((l) => l.textContent.includes("is this the right stream?")), "the line in the pretend Twitch chat");
    await h.until(() => tw.doc.documentElement.classList.contains("tbc-flagging"), "StreamSpace to offer its flag here");
    line.dispatchEvent(new tw.win.MouseEvent("mouseover", { bubbles: true }));
    (await h.until(() => line.querySelector(".tbc-flagbtn"), "the flag button on the line")).click();
    await streamer.next("flash", (m) => m.f.kind === "chat" && m.f.chatter === "hellofoxy" && m.f.text === "is this the right stream?" && m.f.from === "mod1");
    await h.until(() => line.classList.contains("tbc-flagged"), "the line to glow in the Twitch chat");
    h.check(tw.$(".tbc-hubchat") && tw.$(".tbc-phrases-btn"), "the StreamSpace and quick phrases buttons");
    const input = tw.$('[data-a-target="chat-input"]');
    input.textContent = "on it";
    input.dispatchEvent(new tw.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await h.until(() => [...tw.doc.querySelectorAll('.chat-line__message[data-a-user="mod1"]')].some((l) => l.textContent.includes("on it") && l.textContent.includes("BlazeMod420")), "the mod's own line, as BlazeMod420, boxed");
    h.check(tw.$('.chat-line__message[data-a-user="mod1"] .tbc-me'), "the mod's name boxed (StreamSpace's \"your name\")");
    noErrors(tw);
  },
};

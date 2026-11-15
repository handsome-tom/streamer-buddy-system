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
    h.typeAndSend(mod.$(".send__bar .ask__input"), "Can I run the poll now?");
    await h.until(() => streamer.has("Can I run the poll now?"), "the question on the streamer's dock");
    const yes = await h.until(() => streamer.$(".pill--answer.answer--y"), "a Yes button on the dock");
    yes.click();
    await h.until(() => Object.values(modWatch.questions).some((q) => q.text === "Can I run the poll now?" && q.answer?.code === "y"), "the relay to have the answer");
    await h.until(() => /Yes[\s\S]*Can I run the poll now\?/.test(mod.text()), "Yes in the mod's panel");
    await h.until(() => !streamer.hasOnTop("Can I run the poll now?"), "the question to leave the streamer's bar");
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

  async "the streamer's dock shows what's come in one big card at a time, with arrows to step through"(h) {
    const { streamer, mod } = await streamerAndMod(h);
    h.typeAndSend(mod.$(".send__bar .ask__input"), "First question?");
    await h.until(() => streamer.has("First question?"), "the first question on the dock");
    h.typeAndSend(mod.$(".send__bar .ask__input"), "Second question?");
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

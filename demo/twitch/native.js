// "On plain Twitch": for each streamer-side demo button, a picture of what Twitch's own chat
// shows for the same event, with no StreamSpace. Redrawn in Twitch's dark-chat colors (no
// Twitch art). To use a real screenshot instead, drop it in demo/pics/twitch/<button id>.png
// (for example tSub.png): it's shown in place of the drawing.
(() => {
  const ICON = {
    star: "M10 1.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L10 15l-5.2 2.7 1-5.9L1.5 7.7l5.9-.8z",
    gift: "M3 8h14v3H3zM4 11h12v7H4zM9 8h2v10H9zM10 8C8 4 5 4 5 6s3 2 5 2zm0 0c2-4 5-4 5-2s-3 2-5 2z",
    raid: "M7 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM1 17.5c0-3.2 2.7-5.5 6-5.5s6 2.3 6 5.5zM14 5.5l4.5 4.5-4.5 4.5v-3h-2.5V8.5H14z",
    flame: "M10 1c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z",
    gem: "M10 1l7 6-7 12L3 7z",
    points: "M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 3a5 5 0 1 1 0 10 5 5 0 0 1 0-10z",
    pin: "M12 1l7 7-3 1-3 3 1 4-2 2-4-4-5 5-1-1 5-5-4-4 2-2 4 1 3-3z",
    horn: "M2 8h3l8-5v14l-8-5H2zM15 7a4 4 0 0 1 0 6",
    sparkle: "M10 1l2 7 7 2-7 2-2 7-2-7-7-2 7-2z",
    train: "M4 3h12v10H4zM6 5h8v4H6zM3 15h14v2H3zM6 13v2M14 13v2",
  };
  const svg = (name, color = "currentColor", size = 16) =>
    `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true"><path d="${ICON[name]}" fill="${color}"/></svg>`;
  const badge = (bg, letter) => `<span class="nt-badge" style="background:${bg}">${letter}</span>`;
  const SUB = badge("#9147ff", "★");
  const MOD = badge("#00ad03", "⚔");
  const line = (name, color, text, badges = "") =>
    `<div class="nt-line">${badges}<b style="color:${color}">${name}</b>: ${text}</div>`;
  const notice = (icon, sys, msg = "", bar = "#9147ff") =>
    `<div class="nt-notice" style="--bar:${bar}"><div class="nt-notice__sys">${icon}<span>${sys}</span></div>${msg}</div>`;
  const top = (inner) => `<div class="nt-top">${inner}</div>`;

  const SHOTS = {
    tSub: {
      title: "Sub (resub)",
      html: notice(svg("star"), "<b>Captain_Fruit</b> subscribed at Tier 1. They've subscribed for <b>14 months</b>, currently on a 3 month streak!",
        line("Captain_Fruit", "#ff7f50", "another month LETSGO", SUB)),
    },
    tGift: {
      title: "Gift bomb",
      html: notice(svg("gift"), "<b>hellofoxy</b> is gifting <b>20 Tier 1 Subs</b> to the community! They've gifted a total of 64 in the channel!") +
        notice(svg("gift"), "<b>hellofoxy</b> gifted a Tier 1 sub to <b>MiloMunch</b>!") +
        notice(svg("gift"), "<b>hellofoxy</b> gifted a Tier 1 sub to <b>LeonTears</b>!") +
        notice(svg("gift"), "<b>hellofoxy</b> gifted a Tier 1 sub to <b>HoneyBuddy</b>!") +
        `<div class="nt-more">…and 17 more lines like these</div>`,
    },
    tRaid: {
      title: "Raid",
      html: notice(svg("raid", "#bf94ff"), "<b>42 raiders</b> from <b>Lump</b> have joined!") +
        line("Lump", "#8fd14f", "lumpRaid lumpRaid lumpRaid") + line("CuttyKid", "#1e90ff", "RAID HYPE"),
    },
    tFirst: {
      title: "First-time chatter",
      html: `<div class="nt-first"><div class="nt-first__label">${svg("sparkle", "#bf94ff", 14)} First-time chat</div>${line("BadDog15", "#daa520", "hi! found you from the raid, love the vibe")}</div>`,
    },
    tStreak: {
      title: "Watch streak",
      html: notice(svg("flame", "#ff8b3d"), "<b>MacAndCheeseMan</b> watched <b>7 consecutive streams</b> and sparked a watch streak!",
        line("MacAndCheeseMan", "#b22222", "here every time o7"), "#ff8b3d"),
    },
    tCheer: {
      title: "Cheer",
      html: line("SneakySneaky", "#2e8b57", `<span class="nt-cheer"><svg viewBox="0 0 20 24" width="15" height="18" aria-hidden="true"><path d="M10 0 0 16 10 8.8z" fill="#7b2cf0"/><path d="M10 0 10 8.8 20 16z" fill="#a47ef4"/><path d="M0 16 10 8.8 10 24z" fill="#a78bf8"/><path d="M10 8.8 20 16 10 24z" fill="#cbbcfd"/></svg><b style="color:#9c3ee8">100</b></span> GGEZ`, badge("#9c3ee8", "◆")),
    },
    tBadge: {
      title: "Bits badge",
      html: notice('<svg viewBox="0 0 20 24" width="17" height="20" aria-hidden="true"><path d="M10 0 0 16 10 8.8z" fill="#7b2cf0"/><path d="M10 0 10 8.8 20 16z" fill="#a47ef4"/><path d="M0 16 10 8.8 10 24z" fill="#a78bf8"/><path d="M10 8.8 20 16 10 24z" fill="#cbbcfd"/></svg>', "<b>SneakySneaky</b> just earned a new <b>1K Bits badge</b>!", "", "#9c3ee8"),
    },
    tRedeem: {
      title: "Redemption",
      html: `<div class="nt-redeem">${svg("points", "#adadb8", 14)} <b>LeonTears</b> redeemed <b>Hydrate!</b> <span class="nt-cost">${svg("points", "#00c7ac", 13)}500</span></div>` +
        `<div class="nt-redeemwords"><div class="nt-redeemwords__head">Redeemed <b>Say something nice</b> <span class="nt-cost">${svg("points", "#00c7ac", 13)}1,000</span></div>${line("HoneyBuddy", "#ff69b4", "you're doing great today!")}</div>`,
    },
    tHighlight: {
      title: "Highlighted message",
      html: `<div class="nt-hl"><div class="nt-hl__head">Redeemed Highlight My Message ${svg("points", "#fff", 13)}</div>${line("MiloMunch", "#fff", "CAN WE GET A HYPE TRAIN GOING")}</div>`,
    },
    tAnnounce: {
      title: "Announcement",
      html: `<div class="nt-ann" style="--a1:#00db84;--a2:#57bee6"><div class="nt-ann__head">${svg("horn", "#efeff1", 14)} Announcement</div>${line("mod2", "#3fc98e", "Giveaway at the end of the stream, type !enter to join", MOD)}</div>`,
    },
    tPin: {
      title: "Pinned message",
      html: top(`<div class="nt-pin"><div class="nt-pin__head">${svg("pin", "#adadb8", 13)} Pinned by <b>mod2</b></div><div>${MOD}<b style="color:#3fc98e">mod2</b>: Welcome in! Be kind, no spoilers please. Type !commands to see what the bot can do</div></div>`),
    },
    tHype: {
      title: "Hype train",
      html: top(`<div class="nt-hype"><div class="nt-hype__row">${svg("train", "#fff", 16)}<b>Hype Train</b><span class="nt-hype__lvl">LVL 1</span><span class="nt-hype__time">4:32</span></div><div class="nt-bar"><i style="width:38%"></i></div><div class="nt-hype__row nt-small">38% · Top: MacAndCheeseMan (900 bits)</div></div>`),
    },
    tPoll: {
      title: "Poll",
      html: top(`<div class="nt-poll"><div class="nt-poll__q"><b>What should we do next?</b><span>1:45</span></div>` +
        [["Boss fight now", 52], ["Explore first", 31], ["Snack break", 17]].map(([t, p]) =>
          `<div class="nt-opt"><i style="width:${p}%"></i><span>${t}</span><b>${p}%</b></div>`).join("") + `</div>`),
    },
    tPred: {
      title: "Prediction",
      html: top(`<div class="nt-pred"><div class="nt-poll__q"><b>Will we beat the boss?</b><span>Closes in 0:20</span></div><div class="nt-pred__sides">` +
        `<div class="nt-side nt-side--blue"><b>We win this fight</b><span>64% · ${svg("points", "#fff", 12)} 12.4K</span></div>` +
        `<div class="nt-side nt-side--pink"><b>We lose</b><span>36% · ${svg("points", "#fff", 12)} 7K</span></div></div></div>`),
    },
    tCmd: {
      title: "!command",
      html: line("CuttyKid", "#1e90ff", "!discord") + line("StreamElements", "#5b99ff", "Join the Discord: discord.gg/example", badge("#2e2e33", "✓")),
    },
  };

  // Fills `el` with the picture for this button, or a real screenshot if one's been dropped in.
  window.twitchNative = {
    has: (id) => id in SHOTS,
    show(el, id) {
      const s = SHOTS[id];
      if (!s) return;
      el.querySelector(".nt-what").textContent = s.title;
      const body = el.querySelector(".nt-body");
      body.innerHTML = `<div class="nt-chat">${s.html}</div>`;
      const img = new Image();
      img.alt = `${s.title} on Twitch (screenshot)`;
      img.className = "nt-shot";
      img.onload = () => body.replaceChildren(img);
      img.src = `pics/twitch/${id}.png`;
    },
  };
})();

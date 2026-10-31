// The hidden tag on Ask the Streamer whispers, shared word for word with
// Twitch Space (askstreamer.js); if one changes, change both.
//
// A whisper reads like a normal message ("❓ Can I clip that?", "⏳ Soon"), and
// the tag that pairs a question with its answer rides along invisibly as
// Unicode variation selectors (U+E0100–U+E01EF), which show as nothing. Twitch
// keeps them, but only 3 after any one character (more are cut as "glitch
// text"), so they're spread 3 at a time over the first few characters.
//
// The tag: a marker, then "?" + id for a question, or "!" + answer code + id
// for an answer. Ids are 4–10 of a–z0–9.
//
// Older copies sent the tag as visible text ("… [MTT ?k3j9x2]", "… [MTT !k3j9x2 y]");
// read() still understands that, so old and new copies keep talking.
const AskTag = (() => {
  const ALPHABET = "?!abcdefghijklmnopqrstuvwxyz0123456789";
  const BASE = 0xe0100;
  const MARK = 200;
  const PER_CHAR = 3;
  const OLD_RE = /\[MTT ([?!])([a-z0-9]{4,10})(?: ([a-z]))?\]/;
  const HIDDEN_RE = /[\u{E0100}-\u{E01EF}]/gu;
  const isHidden = (ch) => ch.codePointAt(0) >= BASE && ch.codePointAt(0) <= BASE + 0xef;

  // visible text + the tag spread through it.
  function hide(visible, payload) {
    const marks = [MARK, ...[...payload].map((c) => ALPHABET.indexOf(c))].map((i) => String.fromCodePoint(BASE + i));
    let out = "";
    for (const ch of visible) {
      out += ch + marks.splice(0, PER_CHAR).join("");
    }
    while (marks.length) out += " " + marks.splice(0, PER_CHAR).join("");
    return out;
  }

  // { kind: "?" | "!", id, code, text } for a tagged whisper, or null.
  // text is what's left to read, tag removed.
  function read(body) {
    const chars = [...(body || "")];
    const marks = chars.filter(isHidden).map((c) => c.codePointAt(0) - BASE);
    let text = chars.filter((c) => !isHidden(c)).join("").trim();
    let kind, id, code;
    if (marks[0] === MARK) {
      const s = marks.slice(1).map((i) => ALPHABET[i] ?? "").join("");
      kind = s[0];
      if (kind === "!") [code, id] = [s[1], s.slice(2)];
      else id = s.slice(1);
    } else {
      const m = text.match(OLD_RE);
      if (!m) return null;
      [, kind, id, code] = m;
      text = text.replace(OLD_RE, "").trim();
    }
    if (!/^[?!]$/.test(kind) || !/^[a-z0-9]{4,10}$/.test(id) || (kind === "!" && !/^[a-z]$/.test(code || ""))) return null;
    return { kind, id, code: kind === "!" ? code : undefined, text };
  }

  // Someone's own words, with anything that could pass for a tag taken out.
  const clean = (s) => s.replace(HIDDEN_RE, "").replace(/\[MTT/gi, "[mtt").trim();

  const has = (body) => (body || "").includes(String.fromCodePoint(BASE + MARK)) || OLD_RE.test(body || "");

  return { hide, read, clean, has };
})();

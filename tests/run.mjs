#!/usr/bin/env node
// Runs the automatic tests (tests/specs.js) in a hidden Chrome and prints the results.
//
//   node tests/run.mjs            every test
//   node tests/run.mjs nudge      only tests with "nudge" in their name
//
// Nothing to install: it uses the Google Chrome already on this Mac (or $CHROME) and Node's
// own web server and WebSocket. Exits with 1 if anything fails, so it can stop a push.

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, createReadStream, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ONLY = process.argv[2] || "";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TIMEOUT_MS = 180_000;

// ----- A small web server for the repo (what python3 -m http.server does) --------------------
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".gif": "image/gif", ".woff2": "font/woff2", ".ttf": "font/ttf", ".webmanifest": "application/manifest+json", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".txt": "text/plain" };
const server = http.createServer((req, res) => {
  let file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(ROOT)) return res.writeHead(403).end();
  try {
    if (statSync(file).isDirectory()) file = path.join(file, "index.html");
    statSync(file);
  } catch {
    return res.writeHead(404).end();
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

// ----- Hidden Chrome, driven over its DevTools connection ------------------------------------
const profile = mkdtempSync(path.join(tmpdir(), "sbs-tests-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "--mute-audio", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  try { chrome.kill(); } catch {}
  server.close();
  setTimeout(() => {
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    process.exit(code);
  }, 300);
}
chrome.on("error", (e) => {
  console.error(`Couldn't start Chrome (${CHROME}): ${e.message}\nSet CHROME=/path/to/chrome to use another one.`);
  finish(2);
});
setTimeout(() => {
  console.error(`Gave up after ${TIMEOUT_MS / 1000} seconds.`);
  finish(2);
}, TIMEOUT_MS).unref();

const wsUrl = await new Promise((resolve) => {
  let buf = "";
  chrome.stderr.on("data", (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
});

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let nextId = 0;
const waiting = new Map();
const pageLog = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    const { resolve, reject } = waiting.get(m.id);
    waiting.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  } else if (m.method === "Runtime.exceptionThrown") {
    pageLog.push(`exception: ${m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text}`);
  } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    pageLog.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const url = `http://127.0.0.1:${PORT}/tests/harness.html${ONLY ? `?only=${encodeURIComponent(ONLY)}` : ""}`;
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
await send("Page.navigate", { url }, sessionId);

const started = Date.now();
const { result } = await send(
  "Runtime.evaluate",
  {
    expression: "new Promise((r) => { const t = () => (window.testsDone ? window.testsDone.then((x) => r(JSON.stringify(x))) : setTimeout(t, 50)); t(); })",
    awaitPromise: true,
    returnByValue: true,
  },
  sessionId,
);

let results;
try {
  results = JSON.parse(result.value);
} catch {
  console.error("The test page didn't report back.", pageLog.join("\n"));
  finish(2);
}
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}`);
  if (!r.ok) console.log(`    ${r.error.split("\n").slice(0, 3).join("\n    ")}`);
}
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed (${((Date.now() - started) / 1000).toFixed(1)}s)`);
if (failed.length && pageLog.length) console.log(`\nFrom the page:\n${pageLog.slice(-15).join("\n")}`);
if (!results.length) console.log(ONLY ? `No test has "${ONLY}" in its name.` : "No tests ran.");
finish(failed.length || !results.length ? 1 : 0);

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-4jM4Og/strip-cf-connecting-ip-header.js
function stripCfConnectingIPHeader(input, init) {
  const request = new Request(input, init);
  request.headers.delete("CF-Connecting-IP");
  return request;
}
__name(stripCfConnectingIPHeader, "stripCfConnectingIPHeader");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    return Reflect.apply(target, thisArg, [
      stripCfConnectingIPHeader.apply(null, argArray)
    ]);
  }
});

// src/index.js
var WEEK_MS = 7 * 24 * 60 * 60 * 1e3;
var MAX_LEN = 200;
var MAX_OPEN_PER_PAIR = 3;
var MAX_ASKS_PER_MINUTE = 10;
var ANSWER_CODES = "ynmsotc";
var src_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket")
        return new Response("Expected a WebSocket", { status: 426 });
      return env.HUB.get(env.HUB.idFromName("hub")).fetch(req);
    }
    return new Response("Streamer Buddy System relay", { headers: { "content-type": "text/plain" } });
  }
};
var Hub = class {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({});
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const who = ws.deserializeAttachment() || {};
    if (m.t === "auth")
      return this.auth(ws, m.token);
    if (!who.login)
      return this.send(ws, { t: "error", why: "Not signed in" });
    try {
      if (m.t === "connect")
        await this.setConnection(who.login, m.login, true);
      else if (m.t === "disconnect")
        await this.setConnection(who.login, m.login, false);
      else if (m.t === "ask")
        await this.ask(ws, who, m);
      else if (m.t === "answer")
        await this.answer(ws, who, m);
      else if (m.t === "dismiss")
        await this.update(ws, who, m.id, (q) => q.to === who.login && !q.answer && !q.dismissed, (q) => q.dismissed = Date.now());
      else if (m.t === "seen")
        await this.update(ws, who, m.id, (q) => q.from === who.login && q.answer && !q.seenAt, (q) => q.seenAt = Date.now());
    } catch (e) {
      this.send(ws, { t: "error", why: "Something went wrong on the relay" });
    }
  }
  async webSocketClose(ws) {
    await this.left(ws);
  }
  async webSocketError(ws) {
    await this.left(ws);
  }
  // ===== Who's who ===========================================================================
  async auth(ws, token) {
    let j = null;
    if (this.env.DEV_AUTH === "1" && /^dev:[a-z0-9_]+$/.test(token || "")) {
      j = { login: token.slice(4), user_id: token.slice(4), client_id: this.env.TWITCH_CLIENT_ID };
    } else {
      const r = await fetch("https://id.twitch.tv/oauth2/validate", { headers: { Authorization: `OAuth ${token || ""}` } });
      j = r.ok ? await r.json() : null;
    }
    if (!j?.login || j.client_id !== this.env.TWITCH_CLIENT_ID) {
      this.send(ws, { t: "error", why: "signin", detail: "Twitch didn't accept that sign-in" });
      return ws.close(4001, "bad sign-in");
    }
    const was = this.isOnline(j.login);
    ws.serializeAttachment({ login: j.login, id: j.user_id });
    const user = await this.ctx.storage.get(`u:${j.login}`) || { list: [] };
    user.id = j.user_id;
    user.at = Date.now();
    await this.ctx.storage.put(`u:${j.login}`, user);
    await this.sendState(j.login);
    if (!was)
      await this.tellConnections(j.login);
  }
  async left(ws) {
    const who = ws.deserializeAttachment() || {};
    if (who.login && !this.isOnline(who.login, ws))
      await this.tellConnections(who.login);
  }
  sockets(login, except) {
    return this.ctx.getWebSockets().filter((w) => w !== except && w.readyState === 1 && w.deserializeAttachment()?.login === login);
  }
  isOnline(login, except) {
    return this.sockets(login, except).length > 0;
  }
  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
    }
  }
  sendTo(login, msg) {
    for (const ws of this.sockets(login))
      this.send(ws, msg);
  }
  async users() {
    return Object.fromEntries([...await this.ctx.storage.list({ prefix: "u:" })].map(([k, v]) => [k.slice(2), v]));
  }
  async mutual(a, b) {
    const [ua, ub] = await Promise.all([this.ctx.storage.get(`u:${a}`), this.ctx.storage.get(`u:${b}`)]);
    return !!(ua?.list.includes(b) && ub?.list.includes(a));
  }
  // Everything one person's pages need: their connections (and who's online
  // among the mutual ones), requests from people who added them, and the
  // week's questions to or from them.
  async sendState(login) {
    if (!this.isOnline(login))
      return;
    const users = await this.users();
    const mine = users[login]?.list || [];
    const connections = mine.map((l) => {
      const mutual = !!users[l]?.list.includes(login);
      return { login: l, mutual, online: mutual && this.isOnline(l) };
    });
    const requests = Object.entries(users).filter(([l, u]) => l !== login && u.list.includes(login) && !mine.includes(l)).map(([l]) => l);
    const questions = [];
    for (const [k, q] of await this.ctx.storage.list({ prefix: "q:" })) {
      if (Date.now() - q.at > WEEK_MS)
        await this.ctx.storage.delete(k);
      else if (q.from === login || q.to === login)
        questions.push(q);
    }
    this.sendTo(login, { t: "state", me: login, connections, requests, questions });
  }
  // Someone came online or went away: their mutual connections' pages hear.
  async tellConnections(login) {
    const users = await this.users();
    for (const [l, u] of Object.entries(users)) {
      if (u.list.includes(login) && users[login]?.list.includes(l))
        await this.sendState(l);
    }
  }
  async setConnection(login, other, on) {
    other = String(other || "").toLowerCase();
    if (!/^[a-z0-9_]{2,25}$/.test(other) || other === login)
      return;
    const user = await this.ctx.storage.get(`u:${login}`) || { list: [] };
    user.list = on ? [.../* @__PURE__ */ new Set([...user.list, other])] : user.list.filter((l) => l !== other);
    await this.ctx.storage.put(`u:${login}`, user);
    await this.sendState(login);
    await this.sendState(other);
  }
  // ===== Questions ===========================================================================
  async ask(ws, who, m) {
    const to = String(m.to || "").toLowerCase();
    const text = clean(m.text);
    if (!text)
      return;
    if (!await this.mutual(who.login, to))
      return this.send(ws, { t: "error", why: `You and ${to} need to add each other first` });
    const all = [...(await this.ctx.storage.list({ prefix: "q:" })).values()];
    if (all.filter((q2) => q2.from === who.login && Date.now() - q2.at < 6e4).length >= MAX_ASKS_PER_MINUTE) {
      return this.send(ws, { t: "error", why: "That's a lot of questions at once; try again in a minute" });
    }
    if (all.filter((q2) => q2.from === who.login && q2.to === to && !q2.answer && !q2.dismissed).length >= MAX_OPEN_PER_PAIR) {
      return this.send(ws, { t: "error", why: `${to} already has ${MAX_OPEN_PER_PAIR} unanswered questions from you` });
    }
    const q = { id: crypto.randomUUID().slice(0, 8), from: who.login, to, text, at: Date.now(), answer: null, dismissed: 0, seenAt: 0 };
    await this.ctx.storage.put(`q:${q.id}`, q);
    this.share(q);
  }
  async answer(ws, who, m) {
    const code = String(m.code || "");
    if (code.length !== 1 || !ANSWER_CODES.includes(code))
      return;
    const text = code === "c" ? clean(m.text) : "";
    if (code === "c" && !text)
      return;
    await this.update(ws, who, m.id, (q) => q.to === who.login && !q.answer && !q.dismissed, (q) => q.answer = { code, text, at: Date.now() });
  }
  // Change a question if this person's allowed to; both sides hear.
  async update(ws, who, id, allowed, change) {
    const q = await this.ctx.storage.get(`q:${String(id || "")}`);
    if (!q || !allowed(q))
      return this.send(ws, { t: "error", why: "That question can't be changed now" });
    change(q);
    await this.ctx.storage.put(`q:${q.id}`, q);
    this.share(q);
  }
  share(q) {
    this.sendTo(q.from, { t: "q", q });
    this.sendTo(q.to, { t: "q", q });
  }
};
__name(Hub, "Hub");
function clean(s) {
  return String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_LEN);
}
__name(clean, "clean");

// ../../../../.npm/_npx/0eedb5afd4158ff3/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../.npm/_npx/0eedb5afd4158ff3/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-4jM4Og/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../.npm/_npx/0eedb5afd4158ff3/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-4jM4Og/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof __Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
__name(__Facade_ScheduledController__, "__Facade_ScheduledController__");
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = (request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    };
    #dispatcher = (type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    };
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Hub,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map

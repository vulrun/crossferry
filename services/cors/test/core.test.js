import test from "node:test";
import assert from "node:assert/strict";
import { createApp, loadConfig } from "../src/app.js";

const BASE = "https://cors.test";

// stub upstream: routes keyed by URL href (or prefix) → Response factory; records calls
function stubFetch(routes = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url === k || url.startsWith(k));
    // tests without routes just need an upstream that says yes
    if (!key) return Object.keys(routes).length ? new Response("no route for " + url, { status: 404 }) : new Response("ok");
    const handler = routes[key];
    return typeof handler === "function" ? handler(url, init) : handler;
  };
  return { impl, calls };
}

function app(env = {}, options = {}) {
  const { impl, calls } = stubFetch(options.routes);
  const instance = createApp(loadConfig(env), { fetchImpl: options.fetchImpl || impl, now: options.now });
  return { fetch: (path, init) => instance.fetch(new Request(BASE + path, init)), calls };
}

const withOrigin = (extra = {}) => ({ headers: { origin: "https://app.test", ...extra } });

test("preflight answers 200 with CORS headers before any check", async () => {
  const { fetch } = app({ ALLOWED_HOSTS: "nothing.test" });
  const res = await fetch("/https://blocked.test/x", {
    method: "OPTIONS",
    headers: { origin: "https://app.test", "access-control-request-method": "PUT", "access-control-request-headers": "Authorization, X-Y" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("access-control-allow-methods"), "PUT");
  assert.equal(res.headers.get("access-control-allow-headers"), "Authorization, X-Y");
  assert.equal(res.headers.get("access-control-max-age"), "600");
  assert.equal(await res.text(), "");
});

test("preflight defaults when the browser requests nothing specific", async () => {
  const { fetch } = app();
  const res = await fetch("/https://x.test/", { method: "OPTIONS", headers: { origin: "https://app.test" } });
  assert.equal(res.headers.get("access-control-allow-methods"), "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
  assert.equal(res.headers.get("access-control-allow-headers"), "*");
});

test("built-in routes", async () => {
  const { fetch } = app();
  const help = await fetch("/");
  assert.equal(help.status, 200);
  assert.match(await help.text(), /Prefix the URL/);
  assert.equal(help.headers.get("access-control-allow-origin"), "*");

  assert.equal(await (await fetch("/iscorsneeded")).text(), "no");
  assert.equal(await (await fetch("/healthz")).text(), "ok");
  assert.equal((await fetch("/favicon.ico")).status, 404);
});

test("target parsing: explicit scheme, no scheme, :443, collapsed slashes, query string", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return new Response("ok");
  };
  const { fetch } = app({}, { fetchImpl });
  for (const path of [
    "/https://api.test/v1/items?limit=10&q=a%20b",
    "/HTTP://api.test/x",
    "/api.test/x",
    "/api.test:443/x",
    "/https:/api.test/one-slash",
    "//api.test/double",
  ]) {
    assert.equal((await fetch(path, withOrigin())).status, 200, path);
  }
  assert.deepEqual(seen, [
    "https://api.test/v1/items?limit=10&q=a%20b",
    "http://api.test/x",
    "http://api.test/x",
    "https://api.test/x",
    "https://api.test/one-slash",
    "http://api.test/double",
  ]);
});

test("target parsing: bad input is 400 with CORS headers", async () => {
  const { fetch } = app();
  for (const path of ["/https://", "/http://user:pw@api.test/", "/:::"]) {
    const res = await fetch(path, withOrigin());
    assert.equal(res.status, 400, path);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  }
});

test("require-header: Origin or X-Requested-With; configurable; empty disables", async () => {
  const { fetch } = app();
  const bare = await fetch("/https://api.test/");
  assert.equal(bare.status, 400);
  assert.match(await bare.text(), /Missing required request header/);
  assert.equal((await fetch("/https://api.test/", { headers: { "x-requested-with": "XMLHttpRequest" } })).status, 200);

  const custom = app({ REQUIRE_HEADERS: "x-magic" });
  assert.equal((await custom.fetch("/https://api.test/", withOrigin())).status, 400);
  assert.equal((await custom.fetch("/https://api.test/", { headers: { "x-magic": "1" } })).status, 200);

  const open = app({ REQUIRE_HEADERS: "" });
  assert.equal((await open.fetch("/https://api.test/")).status, 200);
});

test("origin allowlist reflects the origin, adds Vary, rejects others; blocklist wins", async () => {
  const { fetch } = app({ ALLOWED_ORIGINS: "https://app.test,https://*.wild.test", BLOCKED_ORIGINS: "https://bad.wild.test" });

  const ok = await fetch("/https://api.test/", { headers: { origin: "https://app.test" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.test");
  assert.match(ok.headers.get("vary"), /Origin/);

  const wild = await fetch("/https://api.test/", { headers: { origin: "https://x.wild.test" } });
  assert.equal(wild.headers.get("access-control-allow-origin"), "https://x.wild.test");

  const other = await fetch("/https://api.test/", { headers: { origin: "https://other.test" } });
  assert.equal(other.status, 403);
  assert.equal(other.headers.has("access-control-allow-origin"), false);

  const blocked = await fetch("/https://api.test/", { headers: { origin: "https://bad.wild.test" } });
  assert.equal(blocked.status, 403);

  const noOrigin = await fetch("/https://api.test/", { headers: { "x-requested-with": "x" } });
  assert.equal(noOrigin.status, 403);
});

test("rate limit: fixed window per origin host, exemptions, reset", async () => {
  let clock = 1_000_000;
  const { fetch } = app({ RATE_LIMIT: "2 1 exempt.test", RATE_LIMIT_EXEMPT: "/(.*\\.)?free\\.test/" }, { now: () => clock });

  const a = (origin) => fetch("/https://api.test/", { headers: { origin } });
  assert.equal((await a("https://app.test")).status, 200);
  assert.equal((await a("https://app.test")).status, 200);
  const third = await a("https://app.test");
  assert.equal(third.status, 429);
  assert.match(await third.text(), /limited to 2 per minute/);

  // another origin has its own bucket
  assert.equal((await a("https://other.test")).status, 200);
  // exemptions never count
  for (let i = 0; i < 5; i++) {
    assert.equal((await a("https://exempt.test")).status, 200);
    assert.equal((await a("https://sub.free.test")).status, 200);
  }
  // window reset
  clock += 60_001;
  assert.equal((await a("https://app.test")).status, 200);
});

test("rate limit: max 0 blocks everyone except exemptions", async () => {
  const { fetch } = app({ RATE_LIMIT: "0 5 vip.test" });
  assert.equal((await fetch("/https://api.test/", { headers: { origin: "https://app.test" } })).status, 429);
  assert.equal((await fetch("/https://api.test/", { headers: { origin: "https://vip.test" } })).status, 200);
});

test("SSRF guard: private literals and localhost are refused; guard can be disabled", async () => {
  const { fetch } = app({ ALLOWED_PORTS: "" });
  for (const target of ["http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5:8080/", "http://localhost/", "http://api.localhost/", "http://[::ffff:192.168.0.1]/"]) {
    const res = await fetch("/" + target, withOrigin());
    assert.equal(res.status, 403, target);
    assert.match(await res.text(), /private address/);
  }
  const open = app({ BLOCK_PRIVATE_IPS: "false", ALLOWED_PORTS: "" });
  assert.equal((await open.fetch("/http://127.0.0.1:8081/", withOrigin())).status, 200);
});

test("port allowlist and host allowlist", async () => {
  const { fetch } = app({ ALLOWED_HOSTS: "api.test,*.cdn.test" });
  assert.equal((await fetch("/https://api.test:8443/", withOrigin())).status, 403);
  assert.equal((await fetch("/https://api.test/", withOrigin())).status, 200);
  assert.equal((await fetch("/https://a.cdn.test/", withOrigin())).status, 200);
  assert.equal((await fetch("/https://cdn.test/", withOrigin())).status, 403);
  assert.equal((await fetch("/https://evil.test/", withOrigin())).status, 403);
  assert.equal((await fetch("/ftp://api.test/", withOrigin())).status, 400);
});

test("forwarding: method, body and headers reach the target; cookies, hop-by-hop and platform headers do not", async () => {
  const { fetch, calls } = app({ SET_HEADERS: "x-powered-by: CrossFerry" }, {
    routes: { "https://api.test/items": () => new Response("created", { status: 201, statusText: "Created" }) },
  });
  const res = await fetch("/https://api.test/items", {
    method: "POST",
    body: "payload",
    headers: {
      origin: "https://app.test",
      "content-type": "text/plain",
      authorization: "Bearer t",
      cookie: "a=b",
      connection: "keep-alive, x-private",
      "x-private": "drop",
      "cf-connecting-ip": "1.2.3.4",
      "x-forwarded-for": "1.2.3.4",
      "accept-encoding": "gzip",
      "x-custom": "keep",
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.statusText, "Created");
  assert.equal(await res.text(), "created");

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, "https://api.test/items");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "manual");
  assert.equal(init.duplex, "half");
  assert.equal(await new Response(init.body).text(), "payload");
  const sent = init.headers;
  assert.equal(sent.get("authorization"), "Bearer t");
  assert.equal(sent.get("content-type"), "text/plain");
  assert.equal(sent.get("origin"), "https://app.test");
  assert.equal(sent.get("x-custom"), "keep");
  assert.equal(sent.get("x-powered-by"), "CrossFerry");
  for (const gone of ["cookie", "connection", "x-private", "cf-connecting-ip", "x-forwarded-for", "accept-encoding", "host"]) {
    assert.equal(sent.has(gone), false, gone);
  }
});

test("response shaping: cookies and upstream CORS removed, ours added, tracing and expose headers set, body streamed", async () => {
  const upstreamHeaders = new Headers({
    "content-type": "application/json",
    "x-rate": "10",
    "access-control-allow-origin": "https://someone-else.test",
    vary: "Accept",
    connection: "close",
  });
  upstreamHeaders.append("set-cookie", "a=1");
  upstreamHeaders.append("set-cookie", "b=2");
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"ok":'));
      c.enqueue(new TextEncoder().encode("true}"));
      c.close();
    },
  });
  const { fetch } = app({ ALLOWED_ORIGINS: "https://app.test" }, {
    routes: { "https://api.test/": () => new Response(stream, { status: 200, headers: upstreamHeaders }) },
  });
  const res = await fetch("/https://api.test/", withOrigin());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get("access-control-allow-origin"), "https://app.test");
  assert.equal(res.headers.get("x-rate"), "10");
  assert.equal(res.headers.has("set-cookie"), false);
  assert.equal(res.headers.has("connection"), false);
  assert.equal(res.headers.get("vary"), "Accept, Origin");
  assert.equal(res.headers.get("x-request-url"), "https://api.test/");
  assert.equal(res.headers.get("x-final-url"), "https://api.test/");
  const exposed = res.headers.get("access-control-expose-headers").split(",");
  for (const name of ["content-type", "x-rate", "x-request-url", "x-final-url", "vary"]) assert.ok(exposed.includes(name), name);
  assert.ok(!exposed.includes("set-cookie"));
});

test("response shaping: encoding headers are dropped because the runtime already decoded the body", async () => {
  const { fetch } = app({}, {
    routes: { "https://api.test/": () => new Response("plain", { headers: { "content-encoding": "gzip", "content-length": "5", "content-type": "text/plain" } }) },
  });
  const res = await fetch("/https://api.test/", withOrigin());
  assert.equal(res.headers.has("content-encoding"), false);
  assert.equal(res.headers.has("content-length"), false);
  assert.equal(await res.text(), "plain");
});

test("redirects: 301/302/303 are followed as GET with tracing headers; relative Location resolved", async () => {
  const { fetch, calls } = app({}, {
    routes: {
      "https://api.test/start": () => new Response(null, { status: 302, headers: { location: "/next" } }),
      "https://api.test/next": () => new Response(null, { status: 303, headers: { location: "https://other.test/final?x=1" } }),
      "https://other.test/final?x=1": () => new Response("done"),
    },
  });
  const res = await fetch("/https://api.test/start", { method: "POST", body: "data", headers: { origin: "https://app.test", "content-type": "text/plain" } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "done");
  assert.equal(res.headers.get("x-request-url"), "https://api.test/start");
  assert.equal(res.headers.get("x-final-url"), "https://other.test/final?x=1");
  assert.equal(res.headers.get("x-cors-redirect-1"), "302 https://api.test/next");
  assert.equal(res.headers.get("x-cors-redirect-2"), "303 https://other.test/final?x=1");

  assert.equal(calls.length, 3);
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[1].init.body, undefined);
  assert.equal(calls[1].init.headers.has("content-type"), false);
  assert.equal(calls[1].init.headers.get("origin"), "https://app.test");
});

test("redirects: a hop to a private address is refused", async () => {
  const { fetch } = app({ ALLOWED_PORTS: "" }, {
    routes: { "https://api.test/": () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }) },
  });
  const res = await fetch("/https://api.test/", withOrigin());
  assert.equal(res.status, 403);
  assert.match(await res.text(), /private address/);
});

test("redirects: 307/308 and over-limit hops are passed through with Location rewritten", async () => {
  const { fetch } = app({ MAX_REDIRECTS: "1" }, {
    routes: {
      "https://api.test/temp": () => new Response(null, { status: 307, headers: { location: "https://api.test/other" } }),
      "https://api.test/loop": () => new Response(null, { status: 302, headers: { location: "https://api.test/loop" } }),
    },
  });
  const temp = await fetch("/https://api.test/temp", withOrigin());
  assert.equal(temp.status, 307);
  assert.equal(temp.headers.get("location"), "https://cors.test/https://api.test/other");

  const loop = await fetch("/https://api.test/loop", withOrigin());
  assert.equal(loop.status, 302);
  assert.equal(loop.headers.get("location"), "https://cors.test/https://api.test/loop");
  assert.equal(loop.headers.get("x-cors-redirect-1"), "302 https://api.test/loop");
  assert.equal(loop.headers.has("x-cors-redirect-2"), false);
});

test("redirects: PUBLIC_BASE_URL and X-Forwarded-* control the rewritten base", async () => {
  const routes = { "https://api.test/t": () => new Response(null, { status: 308, headers: { location: "https://api.test/u" } }) };
  const fixed = app({ PUBLIC_BASE_URL: "https://public.example/" }, { routes });
  assert.equal((await fixed.fetch("/https://api.test/t", withOrigin())).headers.get("location"), "https://public.example/https://api.test/u");

  const forwarded = app({}, { routes });
  const res = await forwarded.fetch("/https://api.test/t", { headers: { origin: "https://app.test", "x-forwarded-proto": "http", "x-forwarded-host": "edge.example:8080" } });
  assert.equal(res.headers.get("location"), "http://edge.example:8080/https://api.test/u");
});

test("same-origin redirect option", async () => {
  const { fetch, calls } = app({ REDIRECT_SAME_ORIGIN: "true" });
  const res = await fetch("/https://app.test/page", withOrigin());
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "https://app.test/page");
  assert.equal(calls.length, 0);
});

test("upstream timeout → 504, upstream failure → 502, both with CORS headers", async () => {
  const slow = app({ UPSTREAM_TIMEOUT_MS: "50" }, {
    fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
  });
  const timeout = await slow.fetch("/https://api.test/", withOrigin());
  assert.equal(timeout.status, 504);
  assert.equal(timeout.headers.get("access-control-allow-origin"), "*");

  const broken = app({}, { fetchImpl: async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); } });
  const failure = await broken.fetch("/https://api.test/", withOrigin());
  assert.equal(failure.status, 502);
  assert.match(await failure.text(), /Bad Gateway/);
});

test("loadConfig validates what it cannot guess", () => {
  assert.throws(() => loadConfig({ RATE_LIMIT: "lots" }), /RATE_LIMIT/);
  assert.throws(() => loadConfig({ RATE_LIMIT: "5 0" }), /RATE_LIMIT/);
  assert.throws(() => loadConfig({ RATE_LIMIT: "5 1 /(/" }), /regular expression/);
  assert.throws(() => loadConfig({ ALLOWED_PORTS: "80,abc" }), /ALLOWED_PORTS/);
  assert.throws(() => loadConfig({ SET_HEADERS: "no-colon" }), /SET_HEADERS/);

  const config = loadConfig({ RATE_LIMIT: "50 3 a.test /b\\.test/", UPSTREAM_TIMEOUT_MS: "junk", MAX_REDIRECTS: "0" });
  assert.equal(config.RATE_LIMIT.max, 50);
  assert.equal(config.RATE_LIMIT.periodMs, 180_000);
  assert.equal(config.RATE_LIMIT.exempt[0], "a.test");
  assert.ok(config.RATE_LIMIT.exempt[1] instanceof RegExp);
  assert.equal(config.UPSTREAM_TIMEOUT_MS, 30000);
  assert.equal(config.MAX_REDIRECTS, 0);
  assert.deepEqual(config.ALLOWED_PORTS, [80, 443]);
  assert.deepEqual(loadConfig({ ALLOWED_PORTS: "" }).ALLOWED_PORTS, []);
});

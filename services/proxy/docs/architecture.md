# Architecture

How a request travels through the forward proxy, what each module is responsible for, and why some things are done the way they are.

> **Repository layout.** This service lives in `services/proxy` of an npm-workspace repository. Beside it: `packages/shared` (runtime-agnostic helpers used by the CORS service) and `services/cors` (the CORS proxy; see its [README](../../cors/README.md)). The `crossferry` CLI at the root runs both services in one process (`crossferry all`); every setting is a `CROSSFERRY_*` variable, see the [root README](../../../README.md). The forward proxy still carries its own copies of the helpers; switching it to `@crossferry/shared` is a planned later step.

- [Overview](#overview)
- [Modules](#modules)
- [Plain HTTP request lifecycle](#plain-http-request-lifecycle)
- [HTTPS (CONNECT) lifecycle](#https-connect-lifecycle)
- [The check pipeline](#the-check-pipeline)
- [Header handling](#header-handling)
- [DNS and the private-address guard](#dns-and-the-private-address-guard)
- [Timeouts](#timeouts)
- [Error handling rules](#error-handling-rules)
- [Shutdown](#shutdown)
- [Design decisions](#design-decisions)

---

## Overview

```
                 ┌──────────────────────── proxy process ───────────────────────┐
                 │                                                              │
 client ──TCP──▶ │  http.Server                                                 │
                 │    ├─ 'request'  → handleHttpRequests  ──http.request──▶ destination (HTTP)
                 │    └─ 'connect'  → handleHttpsTunneling ──net.connect──▶ destination (TCP)
                 │                                                              │
                 │  config.js  ← environment      utils.js ← checks & helpers   │
                 └──────────────────────────────────────────────────────────────┘
```

One `http.Server` listens on `CROSSFERRY_HOST:CROSSFERRY_PORT`. Node's HTTP parser splits incoming traffic into two events:

- `request` for ordinary methods (`GET`, `POST`, …). A proxy client puts the **absolute URL** in the request line, so the proxy knows where to go.
- `connect` for the `CONNECT` method, which asks the proxy to open a raw TCP tunnel. Browsers use this for every HTTPS site.

Both handlers run the same security checks, then diverge: the HTTP handler makes a new HTTP request on the client's behalf; the CONNECT handler opens a socket and pipes bytes.

There is no event loop blocking anywhere: everything is streamed, nothing is buffered in memory beyond Node's socket buffers.

---

## Modules

### `index.js`

The standalone entry point: calls `startProxy(process.env)`, prints any configuration error with a `⛔` prefix and exits with code 1, and installs the `SIGTERM`/`SIGINT` handlers. The root launcher (`../../index.js`) imports `startProxy` from `src/server.js` directly and never runs this file.

### `src/config.js`

Exports `loadConfig(env)`: reads an env object (`process.env`, or a scoped copy when the root launcher embeds this service) into a frozen config, derives `REQUIRE_AUTH`, sets `dns.setDefaultResultOrder("ipv4first")`, and **validates** the result. Validation failures throw a `ConfigError` listing every problem; `index.js` prints them with a `⛔` prefix and exits with code 1. This is what stops an accidental open proxy.

Parsing helpers: `splitStr` (comma list → trimmed, non-empty array) and `parsePositiveInt` (`CROSSFERRY_TIMEOUT_MS` fallback).

### `src/utils.js`

Stateless helpers used by both handlers:

| Function                 | Purpose                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `createLogger(config)`   | `{ access, error }`: timestamped lines to stdout / stderr, gated by `CROSSFERRY_ENABLE_*_LOGS`              |
| `parseURL`               | `new URL()` that returns `null` instead of throwing                                               |
| `getClientIp`            | `socket.remoteAddress` with the `::ffff:` IPv4-mapped prefix removed                              |
| `isAuthValid`            | Parses `Proxy-Authorization: Basic …`, constant-time compare against `CROSSFERRY_AUTH_USER`/`CROSSFERRY_AUTH_PASS`      |
| `isIpAllowed`            | Exact match against `CROSSFERRY_ALLOWED_IPS`                                                                 |
| `isHostAllowed`          | Exact or `*.wildcard` match against `CROSSFERRY_ALLOWED_HOSTS`                                                |
| `isPrivateAddress`       | `net.BlockList` lookup for loopback/private/link-local/multicast/reserved ranges                  |
| `safeLookup`             | `dns.lookup` wrapper that fails with `EBLOCKED` if any resolved address is private                |
| `stripHopByHopHeaders`   | Copy of a header object without connection-level headers and proxy credentials                    |
| `writeRes`               | Send a plain-text error response on an `http.ServerResponse`, safely                              |
| `sendSocketRes`          | Hand-write an HTTP response onto a raw socket (used before a tunnel exists), then close it        |

### `src/server.js`

Exports `createProxyServer(config)` (an `http.Server` with the two request handlers, not yet listening) and `startProxy(env)` (loads config, listens, prints the banner, resolves with `{ server, config, close }`). Signal handling belongs to whichever entry point owns the process. It owns all policy ordering (which check runs first) and all status-code decisions; `utils.js` only answers yes/no questions.

---

## Plain HTTP request lifecycle

```
client                         proxy                                   destination
  │  GET http://ex.com/a HTTP/1.1  │                                        │
  │  Proxy-Authorization: Basic …  │                                        │
  │ ──────────────────────────────▶│                                        │
  │                                │ 1 isIpAllowed(clientIp)      → 403     │
  │                                │ 2 isAuthValid(req)           → 407     │
  │                                │ 3 parseURL, must be http:    → 400     │
  │                                │ 4 isHostAllowed(hostname)    → 403     │
  │                                │ 5 IP literal private?        → 403     │
  │                                │ 6 http.request(url, {lookup: safeLookup})
  │                                │     headers = stripHopByHop(req.headers)
  │                                │ ──── DNS via safeLookup (EBLOCKED → 403) ──▶
  │  request body ───────────────▶ │ ──── req.pipe(proxyReq) ──────────────▶│
  │                                │ ◀─── response headers + body ──────────│
  │ ◀── writeHead(status, stripHopByHop(headers)); pipeline(proxyRes, res) ─│
```

Details that matter:

- **Request line.** Proxy clients send `GET http://host/path`, not `GET /path`. The handler parses `req.url` with `new URL()` and requires `protocol === "http:"`. Anything else (`/`, `https://…`, `ftp://…`) is a 400. Node's `http.request` only speaks plain HTTP, and HTTPS clients use `CONNECT` anyway.
- **Upstream request.** `http.request(targetUrl, { method, headers, timeout, lookup })`. The `Host` header is regenerated by Node from the URL. Default agent settings apply (keep-alive to destinations is handled by Node's global agent).
- **Response.** Status code **and status message** are copied so clients see e.g. `404 Not Found` rather than `404 undefined`. Response headers go through `stripHopByHopHeaders` too, because the destination's `Connection`/`Keep-Alive` describe its link to the proxy, not the proxy's link to the client.
- **Body streaming.** Request body: `req.pipe(proxyReq)`. Response body: `stream.pipeline(proxyRes, res)`. Both are back-pressure aware; a slow client slows the upstream read rather than filling memory.
- **Client goes away.** `res.on("close")` checks `writableFinished`; if the response did not complete, `proxyReq.destroy()` drops the upstream request so the proxy does not keep downloading on behalf of nobody.

---

## HTTPS (CONNECT) lifecycle

```
client                         proxy                                   destination
  │  CONNECT ex.com:443 HTTP/1.1   │                                        │
  │ ──────────────────────────────▶│                                        │
  │                                │ 1 isIpAllowed                → 403     │
  │                                │ 2 isAuthValid                → 407     │
  │                                │ 3 /^(.+):(\d{1,5})$/ + URL   → 400     │
  │                                │ 4 isHostAllowed              → 403     │
  │                                │ 5 IP literal private?        → 403     │
  │                                │ 6 net.connect({host, port, lookup})    │
  │                                │ ──── TCP handshake ───────────────────▶│
  │ ◀── HTTP/1.1 200 Connection Established ──                              │
  │                                │ established = true                     │
  │  TLS ClientHello ────────────▶ │ ──── bytes copied verbatim ───────────▶│
  │ ◀─────────────────────────────── bytes copied verbatim ◀───────────────│
```

Details:

- **Target parsing.** RFC 9110 says the `CONNECT` target is `host:port`, nothing else. The regex pulls the port off the end, then `new URL("http://" + host)` normalizes the hostname (lowercase, punycode, bracketed IPv6). The result must round-trip to exactly `http://<hostname>/`; if the URL parser found a path, userinfo or a second port, the request is malformed → 400. Ports must be 1–65535.
- **IPv6 literals.** `URL` keeps brackets (`[::1]`); `net.connect` wants them bare. The brackets are stripped for the socket and for the private-address check.
- **Early data.** Some clients send the TLS ClientHello in the same packet as the `CONNECT`. Node hands that over as `head`; it is written to the destination before piping starts so nothing is lost.
- **After 200.** `serverSocket.pipe(clientSocket)` and the reverse. The proxy never looks at the bytes. When either side ends, pipes end the other.
- **`established` flag.** Errors before the tunnel is up get an HTTP error response on the client socket. Errors after get a plain socket close, because the client is now speaking TLS and an HTTP response would corrupt the stream.
- **Client socket errors** are hooked up as the very first thing in the handler, before any early return, so a client that disconnects during the checks never produces an unhandled `error` event.

---

## The check pipeline

Both handlers apply checks in the same order and reject at the first failure, **before contacting the destination**:

| #   | Check                     | Rejection | Why this order                                                                        |
| --- | ------------------------- | --------- | ------------------------------------------------------------------------------------- |
| 1   | Client IP in `CROSSFERRY_ALLOWED_IPS` | 403      | Cheapest, and an unlisted IP should learn nothing (not even that auth is required)    |
| 2   | Credentials               | 407       | Unauthenticated clients must not be able to probe host rules or the SSRF guard        |
| 3   | Request shape             | 400       | Nothing below makes sense without a valid target                                      |
| 4   | Host allowlist            | 403       | Policy before network: no DNS query for a host that is not allowed anyway             |
| 5   | Private address (literal) | 403       | For IP targets. Hostnames are checked at DNS time inside `safeLookup`                 |
| 6   | Private address (DNS)     | 403       | Inside the connect attempt; reported through the error path as `EBLOCKED`             |

---

## Header handling

`stripHopByHopHeaders` removes, from both request and response headers:

- The RFC 9110 hop-by-hop set: `connection`, `keep-alive`, `te`, `trailer`, `transfer-encoding`, `upgrade`
- Proxy-specific: `proxy-authorization`, `proxy-authenticate`, `proxy-connection`
- Anything named in the `Connection` header value (e.g. `Connection: x-private` removes `x-private`)

`transfer-encoding` is dropped because Node re-frames the body itself (chunked or content-length) on the new connection. `proxy-authorization` is the important one: without this, every destination site would receive the proxy's username and password.

End-to-end headers such as `Authorization`, `Cookie`, `User-Agent` and `X-Forwarded-*` pass through untouched. The proxy does **not** add `Via` or `X-Forwarded-For`, so destinations see the proxy's IP and nothing about the client.

---

## DNS and the private-address guard

The guard (`CROSSFERRY_BLOCK_PRIVATE_IPS`, on by default) has two parts:

1. **`isPrivateAddress(ip)`** — a single `net.BlockList` built at module load with the IPv4 ranges `0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4` and the IPv6 ranges `::/128, ::1/128, fc00::/7, fe80::/10, ff00::/8`. `BlockList` also matches IPv4-mapped IPv6 addresses (`::ffff:10.0.0.1`) against the IPv4 rules.

2. **`safeLookup`** — passed as the `lookup` option to both `http.request` and `net.connect`. Node calls it instead of `dns.lookup`; it resolves the name, checks **every** returned address, and fails with `code: "EBLOCKED"` if any is private. Since Node 20 uses "happy eyeballs" (`autoSelectFamily`), it asks for all addresses (`all: true`), and the wrapper handles both the array and single-address shapes.

Why `lookup` and not a separate pre-check: Node connects to the exact address the lookup returned. Doing a separate `dns.lookup`, approving it, and then letting `net.connect` resolve again would allow a DNS-rebinding attack where the second resolution returns a private address. With the hook there is only one resolution.

IP literals never go through `lookup`, so the handlers check them with `isPrivateAddress` directly.

`dns.setDefaultResultOrder("ipv4first")` makes dual-stack hostnames prefer IPv4, which avoids slow IPv6 failures on hosts without working IPv6.

---

## Timeouts

`CROSSFERRY_TIMEOUT_MS` is an **idle** timeout, not a total-duration limit:

- HTTP: `timeout` on `http.request` fires when the upstream socket sees no activity for that long. The handler turns it into a synthetic error with `code: "ETIMEDOUT"`, which the error handler maps to `504` (or a connection close if the response had already started).
- CONNECT: `serverSocket.setTimeout(CROSSFERRY_TIMEOUT_MS)`. Before the tunnel is established, firing produces `504`. After, both sockets are destroyed; a long-lived but idle tunnel (for example a browser's unused keep-alive connection) is therefore closed after a minute of silence, and the browser reopens it on demand.

A large download that keeps flowing never times out.

---

## Error handling rules

The handlers follow a few fixed rules so that no failure mode crashes the process or corrupts a response:

1. **Validate before use.** Nothing from the request is destructured or passed to Node APIs until it has been parsed and checked, so malformed input produces a 400, not a `TypeError`.
2. **One error handler per upstream.** `proxyReq.on("error")` is the single place that turns failures (DNS, refused, reset, timeout, blocked) into client responses, based on `err.code`.
3. **Never write twice.** If `res.writableEnded` or `res.destroyed`, do nothing. If `res.headersSent`, destroy the connection instead of writing an error into the body.
4. **Nothing internal reaches the client.** Error responses are fixed strings; `err.message` goes to the error log only.
5. **Sockets always get an `error` listener** before anything can emit one.
6. **Response helpers are defensive.** `writeRes` and `sendSocketRes` validate the status code, catch their own exceptions, and fall back to a bare 500 / socket destroy.

---

## Shutdown

`SIGTERM` and `SIGINT` (from `docker stop`, `pm2 reload`, Ctrl-C) trigger, in `index.js` (or in the root launcher when both services share a process):

1. `server.close()` — stop accepting connections; exit with 0 once every connection has ended.
2. `server.closeIdleConnections()` — drop keep-alive connections that are not mid-request, so step 1 finishes quickly in the common case.
3. An `unref`'d 8-second timer that force-exits, because open `CONNECT` tunnels never end on their own. 8 s is under Docker's default 10 s grace, so containers stop cleanly instead of being killed.

Idle shutdown takes milliseconds; with open tunnels it takes 8 s.

---

## Design decisions

**Why `req.pipe(proxyReq)` for the request body instead of `stream.pipeline`?** `pipeline` destroys every stream in the chain when one fails. If the upstream request fails, that would destroy `req` — and with it the client socket — before the 502/403/504 response could be written. `pipe` leaves the client socket alive for the error response, and the explicit `res.on("close")` handler covers the other direction. The response side does use `pipeline(proxyRes, res)`, where tearing down both on failure is exactly what is wanted.

**Why hash before `timingSafeEqual`?** `crypto.timingSafeEqual` throws if the buffers differ in length, which would itself leak the credential length and need a try/catch. Hashing both sides to SHA-256 gives fixed-length inputs and no branch on length. Both username and password are always compared so the timing does not reveal which one was wrong.

**Why does the private-address check live in `lookup`?** See [DNS and the private-address guard](#dns-and-the-private-address-guard): it is the only placement that is immune to DNS rebinding.

**Why is config validation fatal?** A proxy that starts with a broken allowlist variable name (as the original README suggested) silently becomes an open relay. Failing loudly at startup is the only moment the operator is guaranteed to be watching.

**Why no dependencies?** The whole program is under 500 lines on top of `node:http`, `node:net`, `node:dns` and `node:crypto`. A dependency would add supply-chain exposure, an `npm install` step in the image, and nothing the standard library does not already provide.

**Why CommonJS?** The project predates the ESM switch and nothing here benefits from it. Converting is straightforward if ever wanted.

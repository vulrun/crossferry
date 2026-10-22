# Development

A tour for anyone changing the code: layout, conventions, how the tests work, and how to add a feature safely.

- [Setup](#setup)
- [Code tour](#code-tour)
- [Conventions](#conventions)
- [Tests](#tests)
- [Adding a feature](#adding-a-feature)
- [Manual testing](#manual-testing)
- [Releasing](#releasing)

---

## Setup

```bash
git clone <this repo> && cd <repo>
npm install                 # once, at the repository root (npm workspaces)
cd services/proxy
cp .env.example .env
npm run dev        # restarts on file changes
npm test
```

Node 22.9+ is required. There are no dependencies and no build step. Any editor works; the code is plain CommonJS JavaScript.

---

## Code tour

```
index.js                 standalone entry: startProxy(process.env), signal handling, exit 1 on bad config
src/
  config.js              loadConfig(env) → frozen config; throws ConfigError on unsafe config
  server.js              createProxyServer(config), startProxy(env), startup banner
  utils.js               pure helpers: auth, allowlists, SSRF guard, headers, responses, logging
test/
  proxy.test.js          integration tests; spawns the real entry point
docs/                    this documentation
deploy/docker/           Dockerfile and compose for this service alone (the root Dockerfile runs both services)
```

Read them in the order `config.js` → `utils.js` → `server.js`; each depends only on the ones before it. `server.js` is where policy lives (what is checked, in which order, which status code results). `utils.js` functions answer questions and never decide status codes. `config.js` is the only module that reads environment variables (`loadConfig(env)`; `index.js` and the CLI pass the bare names that `readServiceEnv` derives from the `CROSSFERRY_*` variables).

[architecture.md](architecture.md) explains the request flows in detail.

---

## Conventions

- **Zero dependencies.** Prefer `node:` built-ins. If something truly needs a package, it should be discussed first; the Dockerfile currently skips `npm install` on purpose.
- **CommonJS**, `require`/`module.exports`, exports listed at the top of each file.
- **Logging** only through `log__Access` / `log__Errors`. Never log headers, bodies or credentials.
- **Error responses** use fixed strings. `err.message` goes to the log, never to the client.
- **Every socket gets an `error` listener** before anything else happens on it.
- **Validate, then act.** Do not pass request-derived values to Node APIs (`new URL`, `http.request`, `net.connect`) before they are checked; Node throws synchronously on bad input and that would crash the process.
- **Comments** explain *why* (RFC references, Node quirks, security reasoning), not what the next line does.
- Keep the startup banner honest: if you add a security-relevant setting, print its state there.

---

## Tests

```bash
npm test                       # all tests
node --test --test-name-pattern "CONNECT"   # subset
node --test --watch            # re-run on change
```

### How the harness works

Each test calls `startProxy(t, env)`, which:

1. spawns `node index.js` as a child process with a **clean environment** (only `PATH` plus the test's variables; nothing from your shell or `.env` leaks in),
2. sets `CROSSFERRY_HOST=127.0.0.1`, `CROSSFERRY_PORT=0` and `CROSSFERRY_BLOCK_PRIVATE_IPS=false` by default (tests target local upstreams; the SSRF test overrides this),
3. waits for the `forward proxy listening on 127.0.0.1:<port>` banner line to learn the random port,
4. registers `t.after(() => child.kill())` so every proxy is cleaned up, even on failure.

If the child exits before printing the banner, the promise rejects with the exit code and output, which is how the startup-validation tests assert on `⛔` messages.

Local upstreams are started once in `before()` on `127.0.0.1`:

| Upstream     | Behaviour                                                                 | Used for                        |
| ------------ | ------------------------------------------------------------------------- | ------------------------------- |
| `echoPort`   | HTTP server returning method, URL, headers and body as JSON               | Header stripping, body round-trip, auth, allowlists |
| `hangPort`   | TCP server that accepts and never replies                                 | Timeouts, client abort          |
| `brokenPort` | Sends a 200 with `Content-Length: 100`, writes 7 bytes, then drops        | Mid-body upstream failure       |

Helpers:

- `proxyRequest(port, absoluteUrl, {method, headers, body})` — a plain proxied HTTP request; resolves `{status, headers, body}`.
- `rawRequest(port, text)` — writes raw bytes to the proxy socket and resolves with everything received until close. Used for `CONNECT` and malformed requests.
- `tunnelRequest(port, host)` — builds a `CONNECT` followed by a `GET /tunneled` to send through the tunnel, so a single raw exchange proves the tunnel reached the right port.
- `assertAlive(proxy)` — waits 100 ms and asserts the child has not exited; append it to any test for a case that used to crash.

Tests run in parallel-safe isolation because every proxy has its own port and process. The whole suite takes about 3 seconds.

### Writing a test

```js
test("describes the behaviour, not the implementation", async (t) => {
  const proxy = await startProxy(t, { CROSSFERRY_ALLOWED_HOSTS: "example.invalid" });
  const res = await proxyRequest(proxy.port, `http://127.0.0.1:${echoPort}/`);
  assert.equal(res.status, 403);
  await assertAlive(proxy);
});
```

Use `.invalid` hostnames (RFC 6761) when you need a name that will never resolve, so tests stay offline and deterministic.

When fixing a bug, write the test first and run it against the unfixed code to confirm it fails; the original review did this for every fix, and 13 of the 15 tests fail on the pre-review commit.

---

## Adding a feature

A checklist that keeps the security properties intact:

1. **Config**: add the variable to `src/config.js` with a safe default, parse it there (not in the handler), and add validation if a wrong value could weaken security. Document it in `.env.example`, README and [configuration.md](configuration.md).
2. **Policy**: if it is a new check, slot it into the pipeline in `server.js` in **both** handlers, at the right position (see [architecture.md → The check pipeline](architecture.md#the-check-pipeline)). Checks must run before any upstream contact.
3. **Helpers** go in `utils.js` as pure functions that take values, not request objects, so they are easy to test and reuse.
4. **Banner**: print the new setting's state at startup if it affects who can do what.
5. **Tests**: one for the allowed case, one for the denied case, and `assertAlive` if the input is attacker-controlled.
6. **Docs**: update [security.md](security.md) if the threat model changes, [troubleshooting.md](troubleshooting.md) for any new status code or log label.

Candidates that fit this structure well: a port allowlist, CIDR support in `CROSSFERRY_ALLOWED_IPS`, multiple credential pairs, per-client rate limits, an upstream proxy, TLS on the listener, a `/healthz` endpoint, `ws://` upgrade support.

---

## Manual testing

A quick local loop without Docker:

```bash
# terminal 1
CROSSFERRY_HOST=127.0.0.1 CROSSFERRY_BLOCK_PRIVATE_IPS=false CROSSFERRY_ENABLE_ACCESS_LOGS=true CROSSFERRY_ENABLE_ERROR_LOGS=true npm start

# terminal 2
curl -x http://127.0.0.1:3128 http://example.com/ -I
curl -x http://127.0.0.1:3128 https://example.com/ -I
printf 'GET / HTTP/1.1\r\nHost: x\r\n\r\n' | nc -q1 127.0.0.1 3128      # expect 400
```

To exercise auth and the allowlists, set the variables in terminal 1 and repeat with `-x http://user:pass@…`.

For Docker on a machine where you can run containers: `docker compose up --build` in the foreground shows the banner and logs directly.

---

## Releasing

There is no package to publish; a release is a git tag and, if you use Docker, an image build.

```bash
npm test
git tag -a v1.1.0 -m "…"
git push --tags
docker build -f services/proxy/deploy/docker/Dockerfile -t crossferry-forward:1.1.0 .   # from the repo root
```

Bump `version` in `package.json` alongside the tag. Rebuild the image periodically regardless of code changes to pick up Node patches.

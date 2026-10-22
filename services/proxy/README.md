# CrossFerry forward proxy

A small, zero-dependency forward proxy for HTTP and HTTPS traffic, written in plain Node.js. Point a browser, a phone, `curl` or an app at it and it forwards plain HTTP requests and tunnels HTTPS connections (`CONNECT`) to the destination.

It is built to be run on a VPS or in Docker and exposed to the internet **with authentication**. It refuses to start as an open proxy by accident.

This service lives in `services/proxy` of the [CrossFerry](../../README.md) repository. It runs on its own (`crossferry forward`, this page) or together with the CORS proxy (`crossferry all`). It is **Node-only**: `CONNECT` tunnels need raw TCP, which serverless HTTP platforms do not provide.

- [Quick start](#quick-start)
- [Requirements](#requirements)
- [Running it](#running-it)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Security](#security)
- [Deployment](#deployment)
- [Client setup](#client-setup)
- [Responses and status codes](#responses-and-status-codes)
- [Logging](#logging)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [Limitations](#limitations)
- [Further reading](#further-reading)

---

## Features

- Forward proxy for HTTP (absolute-URL requests) and HTTPS (`CONNECT` tunnels)
- Works with system proxy settings on desktop, Android and iOS, with browsers, `curl`, and `HTTP_PROXY`/`HTTPS_PROXY` environment variables
- Basic authentication (`Proxy-Authorization`), with constant-time credential checks; proxy credentials are **never forwarded** to destination sites
- Client IP allowlist
- Destination host allowlist, with `*.example.com` wildcards
- SSRF guard: refuses to connect to loopback, private, link-local and cloud-metadata addresses (on by default)
- Refuses to start as an open proxy on a public interface
- Hop-by-hop headers stripped in both directions, as a proxy should
- Idle timeouts, clean error handling (no crashes on bad input), graceful shutdown on `SIGTERM`
- No dependencies: `node index.js` is the whole thing
- Docker image and Compose file included
- Test suite with `node --test`

---

## Quick start

```bash
npm install                 # once, at the repository root
cd services/proxy
cp .env.example .env        # set CROSSFERRY_AUTH_USER and CROSSFERRY_AUTH_PASS at minimum
npm start
```

Then, from anywhere that can reach the server:

```bash
curl -x http://alice:secret@your-server:3128 https://ifconfig.me   # HTTPS, via CONNECT
curl -x http://alice:secret@your-server:3128 http://example.com -I # plain HTTP
```

The first command prints your server's public IP, which proves the tunnel works. For Docker, see [Deployment](#deployment).

---

## Requirements

- **Node.js 22.9 or newer** (for `--env-file-if-exists`; the code itself uses only standard modules). Node 24 is what the Docker image uses.
- A host where the proxy port is reachable as a **raw TCP port**. HTTPS proxying uses `CONNECT`, which plain HTTP routers and most "web service" PaaS platforms do not pass through. A VPS, a home server, or a platform with TCP services all work.
- No npm packages of its own. The root `npm install` only wires up the workspace.

---

## Running it

Commands run inside `services/proxy`; from the repository root use `npm <script> -w @crossferry/proxy` instead.

| Command                 | What it does                                                                   |
| ----------------------- | ------------------------------------------------------------------------------ |
| `npm start`             | Runs `node index.js`, loading `.env` if present                                |
| `npm run dev`           | Same, but restarts when a file changes (`node --watch`)                        |
| `npm test`              | Runs the test suite                                                            |
| `npm run docker:up`     | Builds and starts the proxy-only container                                     |
| `npm run docker:logs`   | Follows the container logs                                                     |
| `npm run docker:down`   | Stops and removes the container                                                |
| `npm run pm2:start`     | Starts under pm2 as `crossferry-forward`, loading `.env`                               |
| `npm run pm2:reload`    | Zero-downtime reload under pm2                                                 |
| `npm run pm2:logs`      | Tails pm2 logs                                                                 |

You can also skip `.env` and pass settings inline:

```bash
CROSSFERRY_PORT=3128 CROSSFERRY_AUTH_USER=alice CROSSFERRY_AUTH_PASS=secret CROSSFERRY_ALLOWED_IPS=203.0.113.7 node index.js
```

A variable set in the shell wins over the same variable in `.env`.

On startup the proxy prints its effective security settings:

```
🔰 CrossFerry forward proxy listening on 0.0.0.0:3128
🔒 Basic Auth enabled
⚪ No IP allowlist set
✅ Target allowlist: example.com, *.myapp.com
🛡️ Private/loopback targets blocked
```

To run the forward proxy **and** the CORS proxy in one process, use the repository root instead (`crossferry all`, or `npm start` there). See the [root README](../../README.md).

---

## Configuration

Everything is configured with environment variables. `.env.example` lists them all with comments. Full details, interactions and example setups are in [docs/configuration.md](docs/configuration.md).

| Variable             | Default   | Description                                                                                              |
| -------------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `CROSSFERRY_PORT`               | `3128`    | Port to listen on                                                                                        |
| `CROSSFERRY_HOST`               | `0.0.0.0` | Interface to listen on. `0.0.0.0` = all interfaces, `127.0.0.1` = this machine only                      |
| `CROSSFERRY_AUTH_USER`          | (empty)   | Basic Auth username. Set together with `CROSSFERRY_AUTH_PASS`; setting only one is a startup error                  |
| `CROSSFERRY_AUTH_PASS`          | (empty)   | Basic Auth password. May contain any character, including `:`                                            |
| `CROSSFERRY_ALLOWED_IPS`        | (empty)   | Comma-separated client IPs that may use the proxy, exact match only (e.g. `203.0.113.7,198.51.100.2`). Empty = all |
| `CROSSFERRY_ALLOWED_HOSTS`       | (empty)   | Comma-separated destination hostnames, no ports. `*.example.com` matches subdomains but not `example.com` itself. Empty = all |
| `CROSSFERRY_BLOCK_PRIVATE_IPS`  | `true`    | Refuse destinations that resolve to loopback, private, link-local or similar addresses. Set `false` to proxy to LAN hosts |
| `CROSSFERRY_ALLOW_OPEN_PROXY`   | `false`   | Permit starting on a non-loopback `CROSSFERRY_HOST` with neither auth nor `CROSSFERRY_ALLOWED_IPS`                             |
| `CROSSFERRY_TIMEOUT_MS`         | `60000`   | Idle timeout in milliseconds for upstream HTTP requests and HTTPS tunnels. Invalid values fall back to the default |
| `CROSSFERRY_ENABLE_ERROR_LOGS`  | `false`   | `true` to log errors and rejected requests to stderr                                                      |
| `CROSSFERRY_ENABLE_ACCESS_LOGS` | `false`   | `true` to log every proxied request to stdout                                                             |

### Startup checks

The proxy exits with code 1 and a `⛔` message when:

- only one of `CROSSFERRY_AUTH_USER` / `CROSSFERRY_AUTH_PASS` is set, or
- `CROSSFERRY_HOST` is not loopback (`127.0.0.1`, `::1`, `localhost`) **and** no auth **and** no `CROSSFERRY_ALLOWED_IPS` are configured, unless `CROSSFERRY_ALLOW_OPEN_PROXY=true`.

### Minimal secure setups

```bash
# 1. Password-protected, reachable from anywhere (typical VPS)
CROSSFERRY_AUTH_USER=alice CROSSFERRY_AUTH_PASS='long-random-string'

# 2. No password, but only your office and home IPs may connect
CROSSFERRY_ALLOWED_IPS=203.0.113.7,198.51.100.2

# 3. Both, plus restrict where the proxy may go
CROSSFERRY_AUTH_USER=alice CROSSFERRY_AUTH_PASS='...' CROSSFERRY_ALLOWED_IPS=203.0.113.7 CROSSFERRY_ALLOWED_HOSTS=api.example.com,*.cdn.example.com
```

---

## How it works

Two kinds of requests arrive on the same port. A detailed walkthrough with diagrams is in [docs/architecture.md](docs/architecture.md).

**Plain HTTP** — the client sends a request with an absolute URL (`GET http://example.com/page HTTP/1.1`). The proxy checks the client IP, credentials, destination host and destination address, then makes its own request to the destination with hop-by-hop headers (and your proxy credentials) removed, and streams the response back.

**HTTPS** — the client sends `CONNECT example.com:443`. After the same checks, the proxy opens a TCP connection to the destination, replies `200 Connection Established`, and from then on copies bytes in both directions. The TLS session is between the client and the destination; the proxy cannot read or modify it.

Every rejection happens **before** anything is sent to the destination, in this order: client IP → credentials → request shape → host allowlist → private-address guard.

---

## Security

The full threat model and the list of what the guards do and do not cover is in [docs/security.md](docs/security.md). The short version:

- **Use authentication or an IP allowlist, preferably both**, whenever the proxy is reachable from the internet. The startup check enforces at least one.
- **Credentials travel in plain text** between the client and the proxy (Basic Auth over HTTP, as every HTTP proxy does). Treat the password as something that can be sniffed on untrusted networks, use a long random one, and rotate it if you suspect exposure.
- **The SSRF guard** blocks destinations such as `127.0.0.1`, `10.x`, `192.168.x`, `172.16-31.x`, `169.254.169.254` (cloud metadata) and their IPv6 equivalents, including hostnames that resolve to them. The connection is made to the exact address that was checked, so a DNS record cannot be switched after the check. It does **not** block the server's own public IP; firewall any other services on the host.
- **`CROSSFERRY_ALLOWED_HOSTS`** limits where authenticated users can go. Without it, a user can reach any public host on any port.
- The proxy never forwards `Proxy-Authorization` upstream, never writes error text into an established tunnel, and never exposes internal error messages to clients.

---

## Deployment

Step-by-step guides for Docker, pm2 and systemd, plus firewall and update notes, are in [docs/deployment.md](docs/deployment.md).

### Docker (proxy alone)

From `services/proxy`:

```bash
cp .env.example .env            # set CROSSFERRY_AUTH_USER/CROSSFERRY_AUTH_PASS and/or CROSSFERRY_ALLOWED_IPS
npm run docker:up               # docker compose -f deploy/docker/docker-compose.yml up -d --build
npm run docker:logs
```

The Compose file publishes port 3128, fixes `CROSSFERRY_HOST=0.0.0.0` and `CROSSFERRY_PORT=3128` inside the container, runs as a non-root user, adds a TCP health check and restarts the container unless you stop it. Change the published port in its `ports:` mapping, not in `.env`. `docker compose stop` shuts the proxy down cleanly within 8 seconds.

Without Compose, from the **repository root** (the build context):

```bash
docker build -f services/proxy/deploy/docker/Dockerfile -t crossferry-forward .
docker run -d --name crossferry-forward --restart unless-stopped --init -p 3128:3128 --env-file services/proxy/.env -e CROSSFERRY_HOST=0.0.0.0 -e CROSSFERRY_PORT=3128 crossferry-forward
```

Prebuilt by CI as `ghcr.io/<owner>/crossferry-forward` (`latest` from `main`, semver from `proxy-v*` tags, amd64 + arm64): use that name in place of `crossferry-forward` above, or `CROSSFERRY_FORWARD_IMAGE=ghcr.io/<owner>/crossferry-forward:latest npm run docker:up -- --no-build`. See the [root README](../../README.md#prebuilt-images-github-container-registry) for registry access.

### Docker (both services)

The root `Dockerfile` and `docker-compose.yml` run this proxy and the CORS proxy in one container on `CROSSFERRY_PORT` and `CROSSFERRY_CORS_PORT`. See the [root README](../../README.md#docker).

### pm2

```bash
npm run pm2:start     # loads .env via node's --env-file-if-exists
pm2 save && pm2 startup
```

### Things to know

- **Raw TCP port required.** Vercel, Render web services, Heroku and similar HTTP-only routers cannot carry `CONNECT`; HTTPS proxying will not work behind them. Fly.io, Railway TCP proxy, or any VPS are fine.
- **Client IPs in Docker.** With default port publishing, IPv4 clients keep their real IP. In some setups (IPv6, userland proxy) the proxy sees Docker's bridge gateway instead, which breaks `CROSSFERRY_ALLOWED_IPS`. `network_mode: host` avoids this.
- **Firewall.** Only the proxy port needs to be open. Keep everything else on the host bound to localhost or firewalled, since the SSRF guard does not block the host's own public address.

---

## Client setup

Use `http://` for the proxy address even when proxying HTTPS sites; the proxy itself speaks plain HTTP.

### curl

```bash
curl -x http://alice:secret@your-server:3128 https://example.com/
```

### Environment variables (most CLI tools, Python `requests`, Go, Node 24 with `NODE_USE_ENV_PROXY=1`)

```bash
export HTTP_PROXY=http://alice:secret@your-server:3128
export HTTPS_PROXY=http://alice:secret@your-server:3128
export NO_PROXY=localhost,127.0.0.1
```

### Desktop (Windows / macOS / Linux)

System settings → Network → Proxy → manual HTTP and HTTPS proxy → enter the server address and port. Enter the username and password when prompted.

### Android

Wi-Fi → long-press the network → Modify → Advanced → Proxy: Manual → hostname and port. Android prompts for credentials on first use.

### iOS / iPadOS

Settings → Wi-Fi → (ⓘ) next to the network → Configure Proxy → Manual → server, port, and toggle Authentication on.

### Browsers

- Firefox: Settings → Network Settings → Manual proxy configuration; tick "Also use this proxy for HTTPS".
- Chrome, Edge, Safari: follow the system proxy settings above.

---

## Responses and status codes

Responses generated by the proxy itself have `Content-Type: text/plain` and a one-line body. Responses from the destination are passed through unchanged apart from hop-by-hop headers.

| Status | When                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------ |
| `200 Connection Established` | `CONNECT` succeeded; the tunnel is open                                                        |
| `400`  | The request line is not an absolute `http://` URL, or the `CONNECT` target is not `host:port`               |
| `403`  | Client IP not in `CROSSFERRY_ALLOWED_IPS`, destination not in `CROSSFERRY_ALLOWED_HOSTS`, or destination is a private address      |
| `407`  | Missing or wrong credentials. Includes `Proxy-Authenticate: Basic realm="Proxy"` so clients prompt for them |
| `502`  | Could not reach the destination: DNS failure, connection refused, or connection reset before any response   |
| `504`  | The destination did not respond within `CROSSFERRY_TIMEOUT_MS`                                                          |

If the destination fails **after** the proxy has started sending its response, the proxy closes the client connection rather than appending an error to a partial body. Inside an established tunnel, errors close the tunnel; nothing is written into the TLS stream.

---

## Logging

Logs go to stdout (access) and stderr (errors) so Docker, pm2 and systemd capture them without configuration. Both are off by default; enable with `CROSSFERRY_ENABLE_ACCESS_LOGS=true` and `CROSSFERRY_ENABLE_ERROR_LOGS=true`.

```
[2026-10-21 06:11:35] [HTTP] GET http://example.com/ from 203.0.113.7
[2026-10-21 06:11:36] [CONNECT] example.com:443 from 203.0.113.7
[2026-10-21 06:11:40] [HTTP_AUTH_FAIL] 198.51.100.2
[2026-10-21 06:11:41] [CONNECT_FORBIDDEN] Blocked private target: 10.0.0.5 from 203.0.113.7
[2026-10-21 06:12:02] [HTTP_UPSTREAM_ERROR] example.com:80 ETIMEDOUT Upstream timed out
```

The label after the timestamp tells you what happened; the full list is in [docs/troubleshooting.md](docs/troubleshooting.md#log-labels). Bodies and headers are never logged.

---

## Testing

```bash
npm test            # inside services/proxy, or: npm test -w @crossferry/proxy from the root
```

The suite in `test/proxy.test.js` starts the real `index.js` as a child process for each test, with its own environment and a random port, and runs requests through it against local echo, hanging and misbehaving upstream servers. It covers every bug fixed in the review (crashes, credential leak, allowlists, auth edge cases, tunnel ports), the SSRF guard, wildcards, body streaming and the startup checks. No network access is needed. See [docs/development.md](docs/development.md) for how to add a test.

---

## Troubleshooting

| Symptom                                   | Likely cause                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Exits immediately with `⛔ Refusing to run an open proxy` | No `CROSSFERRY_AUTH_USER`/`CROSSFERRY_AUTH_PASS` and no `CROSSFERRY_ALLOWED_IPS` while listening publicly. Configure one, or set `CROSSFERRY_ALLOW_OPEN_PROXY=true` if you really mean it |
| `407` even with the right password        | Check the client sends `Proxy-Authorization` (not `Authorization`); check for a trailing space or quote problem in `.env` |
| `403` for every client                    | `CROSSFERRY_ALLOWED_IPS` does not contain the address the proxy sees. In Docker that may be the bridge gateway; look at the `[*_FORBIDDEN] Blocked IP:` log line |
| `403 private address not allowed` for a LAN/localhost target | Expected. Set `CROSSFERRY_BLOCK_PRIVATE_IPS=false` if you need to reach private hosts |
| HTTPS sites fail but HTTP works           | Something between the client and the proxy is an HTTP-only router that drops `CONNECT`. Expose a raw TCP port |
| `docker stop` takes 10 seconds            | Only happens with open tunnels; the proxy force-exits after 8 s. Idle shutdown is instant        |

More cases, diagnostic commands and the log label reference: [docs/troubleshooting.md](docs/troubleshooting.md).

---

## Project layout

```
index.js              standalone entry: starts the proxy, handles SIGTERM, exits 1 on bad config
src/config.js         loadConfig(env): reads and validates settings, throws on unsafe config
src/server.js         createProxyServer(config) and startProxy(env): request handler, CONNECT handler
src/utils.js          auth, allowlists, SSRF guard, header filtering, response helpers, logging
test/proxy.test.js    integration tests (node --test)
docs/                 architecture, configuration, security, deployment, troubleshooting, development
deploy/docker/        Dockerfile and compose for running this service alone
.env.example          every setting with a comment
```

---

## Limitations

Known gaps, by design or not yet built:

- **No TLS on the proxy port.** Clients talk plain HTTP to the proxy, so credentials and plain-HTTP traffic are visible on the path between client and proxy.
- **No `ws://` WebSockets** through plain HTTP; the request is dropped. `wss://` works, because it goes through `CONNECT`.
- **No port allowlist.** Authenticated users can `CONNECT` to any port on an allowed host.
- **`CROSSFERRY_ALLOWED_IPS` is exact-match only**, no CIDR ranges.
- **Single shared credential.** There is one username/password for everyone.
- **No rate limiting, quotas or metrics.**
- **No HTTPS inspection.** Tunnels are opaque; the proxy cannot filter by URL inside HTTPS.
- **Not a reverse proxy.** It only serves clients that are configured to use a proxy.
- **Node only.** Serverless HTTP platforms cannot carry `CONNECT`; use the CORS proxy there.

---

## Further reading

- [docs/architecture.md](docs/architecture.md) — request lifecycle, module responsibilities, design decisions
- [docs/configuration.md](docs/configuration.md) — every setting in depth, `.env` rules, example setups
- [docs/security.md](docs/security.md) — threat model, guard details, hardening checklist
- [docs/deployment.md](docs/deployment.md) — Docker, pm2, systemd, firewall, updates
- [docs/troubleshooting.md](docs/troubleshooting.md) — symptoms, diagnostics, status codes, log labels
- [docs/development.md](docs/development.md) — code tour, tests, adding features

---

## License

MIT License — see [LICENSE](../../LICENSE). Feel free to modify and use responsibly.

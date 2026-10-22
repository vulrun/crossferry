# Configuration

Every setting is an environment variable. This page explains each one in depth, how `.env` is loaded, how settings interact, and gives ready-made setups.

- [How settings are loaded](#how-settings-are-loaded)
- [Reference](#reference)
- [Startup validation](#startup-validation)
- [Example setups](#example-setups)
- [Changing settings at runtime](#changing-settings-at-runtime)

---

## How settings are loaded

`npm start` runs `node --env-file-if-exists=.env index.js`. Node reads `.env` itself; there is no dotenv library.

Rules:

- **Shell wins.** A variable already set in the environment is not overwritten by `.env`. `CROSSFERRY_PORT=4000 npm start` uses 4000 even if `.env` says 3128.
- **Quotes are optional.** `CROSSFERRY_AUTH_PASS=secret` and `CROSSFERRY_AUTH_PASS="secret"` are the same. Use quotes when the value has spaces or `#`.
- **No file is fine.** If `.env` is missing, Node prints `.env not found. Continuing without it.` and carries on with whatever the shell provides.
- **Docker** does not use this flag. Compose reads `.env` through `env_file:` and injects the variables into the container; `docker run --env-file .env` does the same.
- **pm2** passes the flag through `--node-args`, so `.env` is re-read on every `pm2 reload`.
- Settings are read **once at startup**. Editing `.env` has no effect until the process restarts.

---

## Reference

### `CROSSFERRY_PORT`

- Default: `3128` (the conventional proxy port; `8080` and `8888` are also common)
- Any free TCP port. `0` picks a random free port and prints it in the banner (useful for tests).
- Ports below 1024 need root or `CAP_NET_BIND_SERVICE` outside Docker.

### `CROSSFERRY_HOST`

- Default: `0.0.0.0` (all IPv4 interfaces)
- `127.0.0.1` restricts the proxy to the machine it runs on. This also satisfies the open-proxy startup check, so a local-only proxy needs no auth.
- `::` listens on all IPv6 **and** IPv4 interfaces on most Linux hosts.
- Inside Docker it must be `0.0.0.0` (or `::`), otherwise the published port cannot reach it. `docker-compose.yml` sets this for you.

### `CROSSFERRY_AUTH_USER` and `CROSSFERRY_AUTH_PASS`

- Default: empty (authentication off)
- Set both to require `Proxy-Authorization: Basic <base64(user:pass)>` on every request. Setting only one is a startup error.
- The password may contain any character, including `:`; the proxy splits on the **first** colon only, as RFC 7617 requires. The username cannot contain `:`.
- Comparison is constant-time. The scheme name is case-insensitive (`Basic`, `basic`).
- Wrong or missing credentials get `407` with `Proxy-Authenticate: Basic realm="Proxy"`, which makes browsers and OS proxy settings prompt for a login.
- Only one credential pair is supported. Everyone shares it.
- Use a long random password (`openssl rand -base64 24`). It is sent base64-encoded, not encrypted, between client and proxy.

### `CROSSFERRY_ALLOWED_IPS`

- Default: empty (any client may connect, subject to auth)
- Comma-separated list of exact client IP addresses: `203.0.113.7,198.51.100.2,2001:db8::1`
- Matching is exact string comparison after removing the `::ffff:` prefix that Node adds to IPv4 clients on dual-stack sockets. There is no CIDR or wildcard support.
- IPv6 addresses must be written the way Node reports them: lowercase and compressed (`2001:db8::1`, not `2001:0db8:0000::0001`).
- Rejected clients get `403` before the credential check, so they cannot even tell whether auth is enabled.
- In Docker, check what address the proxy actually sees before relying on this (see [deployment.md](deployment.md#client-ips-behind-docker)).

### `CROSSFERRY_ALLOWED_HOSTS`

- Default: empty (any destination, subject to the private-address guard)
- Comma-separated destination hostnames **without ports**: `example.com,*.cdn.example.com`
- `example.com` matches only `example.com`.
- `*.example.com` matches `a.example.com` and `a.b.example.com`, but **not** `example.com`. List both if you want both.
- Case-insensitive. A trailing dot (`example.com.`) is ignored.
- Internationalized names are compared in punycode form (`xn--…`), because that is what the URL parser produces.
- IPv6 literal destinations appear with brackets, so list them as `[2001:db8::1]`.
- Applies to both plain HTTP and `CONNECT`. It does not restrict ports: an allowed host may be reached on any port.
- A blocked destination gets `403 Forbidden: host not allowed by proxy allowlist` and no DNS lookup is made.

### `CROSSFERRY_BLOCK_PRIVATE_IPS`

- Default: `true`. Only the exact string `false` turns it off.
- When on, the proxy refuses destinations whose address (literal, or any address a hostname resolves to) is in:

  | Family | Ranges                                                                                                                      |
  | ------ | --------------------------------------------------------------------------------------------------------------------------- |
  | IPv4   | `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (CGNAT), `127.0.0.0/8`, `169.254.0.0/16` (link-local, cloud metadata), `172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4` (multicast), `240.0.0.0/4` (reserved) |
  | IPv6   | `::/128`, `::1/128`, `fc00::/7` (ULA), `fe80::/10` (link-local), `ff00::/8` (multicast), plus IPv4-mapped addresses of the ranges above |

- Rejections return `403 Forbidden: private address not allowed`.
- Turn it off when the proxy's purpose is to reach hosts on your LAN or in a private cloud network. Then use `CROSSFERRY_ALLOWED_HOSTS` to limit which ones.
- It does not block the proxy host's own public IP, nor public IPs that happen to route somewhere sensitive. See [security.md](security.md).

### `CROSSFERRY_ALLOW_OPEN_PROXY`

- Default: `false`. Only the exact string `true` enables it.
- Lets the proxy start on a non-loopback `CROSSFERRY_HOST` with no `CROSSFERRY_AUTH_USER`/`CROSSFERRY_AUTH_PASS` and no `CROSSFERRY_ALLOWED_IPS`. Use it only on a network that is already closed (a private VPC, a home LAN behind NAT, a Docker network that is not published). Anyone who can reach the port can use your server's bandwidth and IP reputation.

### `CROSSFERRY_TIMEOUT_MS`

- Default: `60000` (60 seconds). Must be a positive integer; anything else silently falls back to the default.
- An **idle** timeout: it fires when a connection to the destination carries no data for this long, not when a request has lasted this long in total. A multi-hour download that keeps flowing is never cut.
- For plain HTTP, expiry before any response yields `504`; after the response has started, the connection is closed.
- For tunnels, expiry before the tunnel is up yields `504`; an established tunnel that is idle for this long is closed (clients reconnect automatically).
- Lower it (10–20 s) for API-only use to free resources faster; raise it for slow upstreams or long-polling.

### `CROSSFERRY_ENABLE_ERROR_LOGS`

- Default: `false`. Only `true` enables it.
- Writes rejected requests, upstream failures and internal errors to **stderr** with a timestamp and a label. See [troubleshooting.md](troubleshooting.md#log-labels).
- Recommended on in production; the volume is low.

### `CROSSFERRY_ENABLE_ACCESS_LOGS`

- Default: `false`. Only `true` enables it.
- Writes one line per proxied request to **stdout**: method, URL or `host:port`, and client IP. No headers, bodies or credentials.
- Note that for HTTPS only `host:port` is visible; the proxy never sees the URL path inside a tunnel.

---

## Startup validation

`loadConfig` (`src/config.js`) rejects the configuration, and `index.js` exits with code 1, if:

| Condition                                                                                                    | Message                                        |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Exactly one of `CROSSFERRY_AUTH_USER` / `CROSSFERRY_AUTH_PASS` is set                                                              | `Set both CROSSFERRY_AUTH_USER and CROSSFERRY_AUTH_PASS, or neither` |
| No auth, no `CROSSFERRY_ALLOWED_IPS`, `CROSSFERRY_HOST` is not `127.0.0.1`/`::1`/`localhost`, and `CROSSFERRY_ALLOW_OPEN_PROXY` is not `true` | `Refusing to run an open proxy on <CROSSFERRY_HOST>: …`   |

Both messages are printed with a `⛔` prefix. Under Docker with `restart: unless-stopped` a bad config shows up as a container in a restart loop; `docker compose logs` shows the reason.

---

## Example setups

### Personal proxy on a VPS

```dotenv
CROSSFERRY_AUTH_USER="alice"
CROSSFERRY_AUTH_PASS="xk3Jv9…(long random)…"
CROSSFERRY_ENABLE_ERROR_LOGS="true"
CROSSFERRY_ENABLE_ACCESS_LOGS="true"
```

Reachable from anywhere with the password. Private targets blocked (default).

### Office egress with fixed IPs, no passwords

```dotenv
CROSSFERRY_ALLOWED_IPS="203.0.113.7,203.0.113.8"
CROSSFERRY_ENABLE_ERROR_LOGS="true"
```

Only those two addresses can connect. Add auth as well if the office IPs are shared with others.

### Locked to specific APIs (e.g. for a mobile app or scraper)

```dotenv
CROSSFERRY_AUTH_USER="app"
CROSSFERRY_AUTH_PASS="…"
CROSSFERRY_ALLOWED_HOSTS="api.example.com,*.cdn.example.com"
CROSSFERRY_TIMEOUT_MS="20000"
```

Users can reach only those hosts. Everything else is `403`.

### Reaching LAN devices from outside

```dotenv
CROSSFERRY_AUTH_USER="home"
CROSSFERRY_AUTH_PASS="…"
CROSSFERRY_BLOCK_PRIVATE_IPS="false"
CROSSFERRY_ALLOWED_HOSTS="printer.lan,nas.lan,192.168.1.20"
```

The guard is off, so the allowlist is what keeps users away from the rest of the network. Keep it tight.

### Local development, no restrictions

```dotenv
CROSSFERRY_HOST="127.0.0.1"
CROSSFERRY_BLOCK_PRIVATE_IPS="false"
CROSSFERRY_ENABLE_ACCESS_LOGS="true"
```

Loopback-only, so the open-proxy check is satisfied without auth. Handy for inspecting what an app sends.

---

## Changing settings at runtime

There is no hot reload. After editing `.env`:

- `npm start`: stop (Ctrl-C) and start again.
- pm2: `npm run pm2:reload`.
- Docker Compose: `docker compose up -d` (re-creates the container when `.env` changed) or `docker compose restart`.

Restarts are quick: idle shutdown is instant, and open HTTPS tunnels are dropped after at most 8 seconds; clients reconnect transparently.

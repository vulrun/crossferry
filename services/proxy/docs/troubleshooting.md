# Troubleshooting

Symptoms, causes and fixes, followed by diagnostic commands, the status-code table and the log label reference.

- [First steps](#first-steps)
- [Startup problems](#startup-problems)
- [Clients cannot connect or get errors](#clients-cannot-connect-or-get-errors)
- [Destination problems](#destination-problems)
- [Docker-specific](#docker-specific)
- [Diagnostic commands](#diagnostic-commands)
- [Status codes](#status-codes)
- [Log labels](#log-labels)

---

## First steps

1. Turn on logging: `CROSSFERRY_ENABLE_ERROR_LOGS=true` and `CROSSFERRY_ENABLE_ACCESS_LOGS=true`, restart.
2. Read the startup banner. It states the effective auth, allowlist and guard settings; most "it worked yesterday" problems are visible there.
3. Reproduce with `curl -v` from the client machine (commands below). `curl` shows the exact status the proxy returned, which browsers hide.

---

## Startup problems

### `⛔ Refusing to run an open proxy on 0.0.0.0`

No `CROSSFERRY_AUTH_USER`/`CROSSFERRY_AUTH_PASS` and no `CROSSFERRY_ALLOWED_IPS`, while listening on a public interface. Set one of them. For a local-only proxy use `CROSSFERRY_HOST=127.0.0.1`. For a deliberately open proxy on a closed network, `CROSSFERRY_ALLOW_OPEN_PROXY=true`.

### `⛔ Set both CROSSFERRY_AUTH_USER and CROSSFERRY_AUTH_PASS, or neither`

One of the two is empty. Common cause: a `.env` line with a typo in the name, or the password line missing after a copy-paste.

### `Error: listen EADDRINUSE`

Something else is on the port. `ss -ltnp | grep 3128` shows what. Change `CROSSFERRY_PORT` or stop the other process. Under pm2 this often means an older instance is still running: `pm2 list`.

### `Error: listen EACCES`

Port below 1024 without privileges. Use a higher port, or see the `setcap`/`AmbientCapabilities` notes in [deployment.md](deployment.md).

### Container restarts in a loop

`docker compose logs proxy` — almost always one of the `⛔` messages above. Fix `.env` and `docker compose up -d`.

### `.env not found. Continuing without it.`

Informational. Node did not find `.env` in the current directory. Harmless if you pass settings another way; otherwise `cp .env.example .env`.

---

## Clients cannot connect or get errors

### Connection refused / timed out from the client

- Proxy not running (`docker compose ps`, `pm2 status`, `systemctl status`).
- `CROSSFERRY_HOST=127.0.0.1` while connecting from another machine. Use `0.0.0.0`.
- Firewall or security group not allowing the port. Test from the server itself first: `curl -x http://127.0.0.1:3128 http://example.com -I`.
- In Docker, `CROSSFERRY_HOST` inside the container is not `0.0.0.0` (the Compose file forces it; a hand-written `docker run` might not).

### `407 Proxy Authentication Required`

- Client is not sending credentials. In `curl`, put them in the proxy URL: `-x http://user:pass@host:3128`. In environment variables: `HTTP_PROXY=http://user:pass@host:3128`.
- Wrong credentials. Note that `.env` values are taken literally; a trailing space inside quotes is part of the password.
- Password contains characters that need URL-encoding when placed in a URL (`@` → `%40`, `:` → `%3A`, `#` → `%23`). The proxy itself accepts any characters; the client's URL parser is the problem.
- Client sends `Authorization` instead of `Proxy-Authorization`. That is a client bug or a reverse-proxy misuse; this is a forward proxy.

### `403 Forbidden: you are not allowed to use this proxy`

The client IP is not in `CROSSFERRY_ALLOWED_IPS`. The error log line `[HTTP_FORBIDDEN] Blocked IP: x.x.x.x` shows the address the proxy saw. If it is a Docker-internal address like `172.17.0.1`, see [Docker-specific](#docker-specific). If it is an IPv6 address, add that exact form to the list.

### `403 Forbidden: host not allowed by proxy allowlist`

Destination is not in `CROSSFERRY_ALLOWED_HOSTS`. Remember `*.example.com` does not include `example.com`; list both. Check the error log for the exact hostname being matched (lowercase, no port).

### `403 Forbidden: private address not allowed`

The destination is loopback, LAN, link-local or similar, or a hostname that resolves to one. This is the SSRF guard doing its job. If reaching private hosts is intended, set `CROSSFERRY_BLOCK_PRIVATE_IPS=false` and constrain with `CROSSFERRY_ALLOWED_HOSTS`.

### `400 Bad Request: expected an absolute http:// URL`

The client sent an origin-form request (`GET /path`) or an `https://` URL as a plain request. The first usually means something hit the proxy port thinking it is a web server (health checkers, scanners, a browser opening `http://proxy:3128/` directly). The second means a client is misconfigured to send HTTPS URLs without `CONNECT`; set the HTTPS proxy in the client to the same `http://host:3128` address.

### `400 Bad Request` on CONNECT

The target was not `host:port`. Seen with broken clients or hand-written requests missing the port.

### HTTPS sites fail, HTTP works

Something between client and proxy does not pass `CONNECT`. Typical: the proxy is behind an HTTP-only load balancer, Cloudflare, nginx `proxy_pass`, or a PaaS web router. Expose a raw TCP port instead. `curl -v` shows `CONNECT` getting a non-200 response or no response.

### Browser keeps prompting for the password

The browser receives `407` repeatedly. Usually the password typed differs from `CROSSFERRY_AUTH_PASS` (check for leading/trailing whitespace in `.env`), or the browser is talking to a different proxy than you think (system vs. browser-level settings).

### `ws://` WebSocket does not work

Not supported over plain HTTP; the proxy drops the request. `wss://` works, because it travels through a `CONNECT` tunnel. Use `wss://` or connect directly.

---

## Destination problems

### `502 Bad Gateway`

The proxy could not get a response from the destination. The error log has the detail:

| Log detail                   | Meaning                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `ENOTFOUND`                  | DNS could not resolve the hostname                             |
| `ECONNREFUSED`               | Host reachable, nothing listening on that port                 |
| `ECONNRESET` / `socket hang up` | Destination closed the connection before answering          |
| `EHOSTUNREACH` / `ENETUNREACH` | No route from the proxy host (firewall, no IPv6, etc.)       |
| `EBLOCKED`                   | Private-address guard (clients see 403, not 502)               |

Test from the proxy host directly (`curl -v http://destination/`) to separate proxy problems from network problems.

### `504 Proxy Gateway Timed Out`

No data from the destination for `CROSSFERRY_TIMEOUT_MS`. Either the destination is slow or hanging, or outbound traffic is being silently dropped by a firewall. Raise `CROSSFERRY_TIMEOUT_MS` for known-slow upstreams.

### Response cut off / connection closed mid-download

The destination dropped the connection, or it went idle for `CROSSFERRY_TIMEOUT_MS`. The proxy closes the client connection on purpose rather than sending a misleading error inside the body. Error log: `[HTTP_STREAM_ERROR]` or `[HTTP_UPSTREAM_ERROR]`.

### Long-lived HTTPS connection drops after about a minute

Idle tunnels are closed after `CROSSFERRY_TIMEOUT_MS`. Clients reconnect automatically; if yours does not, raise the timeout.

### Wrong site / `Host` mismatch

Not caused by the proxy: it regenerates `Host` from the URL the client sent. Check the client's request.

---

## Docker-specific

### All clients get 403 with `Blocked IP: 172.x.x.x`

The proxy sees Docker's bridge gateway instead of the client. See [deployment.md → Client IPs behind Docker](deployment.md#client-ips-behind-docker): use `network_mode: host`, or switch from `CROSSFERRY_ALLOWED_IPS` to authentication.

### `docker compose stop` takes 10 seconds

Only when tunnels are open; the proxy waits up to 8 s for them, then exits. Idle shutdown is immediate. If it consistently hits 10 s and gets killed, `init: true` is probably missing from the Compose file (signals are not reaching Node).

### Health check `unhealthy`

The TCP probe to the proxy port inside the container failed. Usually the process exited on config validation; check the logs. The probe uses `CROSSFERRY_PORT` from the environment, which Compose fixes at 3128.

### `.env` changes not applied

`docker compose restart` does not re-read `env_file`. Use `docker compose up -d`, which re-creates the container when its configuration changed.

---

## Diagnostic commands

From any client (replace host, port and credentials):

```bash
# does the port answer at all?
nc -vz proxy.example.com 3128

# plain HTTP through the proxy, verbose
curl -v -x http://alice:secret@proxy.example.com:3128 http://example.com/ -o /dev/null

# HTTPS through the proxy; look for "CONNECT example.com:443" and "200 Connection Established"
curl -v -x http://alice:secret@proxy.example.com:3128 https://example.com/ -o /dev/null

# what does the proxy do with a bare request? (expect 400)
curl -i http://proxy.example.com:3128/

# what public IP do destinations see?
curl -x http://alice:secret@proxy.example.com:3128 https://ifconfig.me

# raw CONNECT by hand
printf 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n' | nc proxy.example.com 3128
```

On the server:

```bash
ss -ltnp | grep 3128               # is it listening, and as which process?
docker compose logs -f --tail 200  # or: pm2 logs crossferry-forward / journalctl -u crossferry-forward -f
curl -v http://example.com/ -o /dev/null   # can the host itself reach the internet?
```

---

## Status codes

Produced by the proxy itself (destination responses pass through unchanged):

| Status | Body                                                  | Cause                                                              |
| ------ | ----------------------------------------------------- | ------------------------------------------------------------------ |
| 200    | `Connection Established` (status line only)           | `CONNECT` succeeded                                                |
| 400    | `Bad Request: expected an absolute http:// URL`       | Request line is not `http://…`                                     |
| 400    | `Bad Request`                                         | `CONNECT` target is not `host:port` with port 1–65535              |
| 403    | `Forbidden: you are not allowed to use this proxy`    | Client IP not in `CROSSFERRY_ALLOWED_IPS`                                     |
| 403    | `Forbidden: host not allowed by proxy allowlist`      | Destination not in `CROSSFERRY_ALLOWED_HOSTS`                                  |
| 403    | `Forbidden: private address not allowed`              | Destination is a private/loopback address (literal or resolved)    |
| 407    | `Proxy Authentication Required`                       | Missing or wrong `Proxy-Authorization`; `Proxy-Authenticate` header included |
| 502    | `Bad Gateway`                                         | DNS failure, connection refused or reset before any response       |
| 504    | `Proxy Gateway Timed Out` / `Gateway Timeout`         | No response within `CROSSFERRY_TIMEOUT_MS` (HTTP / `CONNECT`)                 |

All proxy-generated responses have `Content-Type: text/plain`; `CONNECT` rejections also carry `Connection: close`.

---

## Log labels

Format: `[YYYY-MM-DD HH:MM:SS] [LABEL] details`. Access lines go to stdout, error lines to stderr.

### Access (stdout, `CROSSFERRY_ENABLE_ACCESS_LOGS=true`)

| Label           | Details                                          |
| --------------- | ------------------------------------------------ |
| `HTTP`          | `METHOD http://url from clientIp`                |
| `CONNECT`       | `host:port from clientIp`                        |
| `SERVER_CLOSED` | Listener closed (shutdown)                       |

### Errors (stderr, `CROSSFERRY_ENABLE_ERROR_LOGS=true`)

| Label                    | Meaning                                                                  |
| ------------------------ | ------------------------------------------------------------------------ |
| `HTTP_FORBIDDEN`         | Plain request rejected: `Blocked IP:`, `Blocked Host:` or `Blocked private target:` |
| `HTTP_AUTH_FAIL`         | Plain request with missing/wrong credentials; details = client IP        |
| `HTTP_BAD_REQUEST`       | Request line not an absolute `http://` URL                               |
| `HTTP_UPSTREAM_ERROR`    | Upstream request failed; details = `host:port CODE message`              |
| `HTTP_STREAM_ERROR`      | Response body transfer to the client failed after headers were sent      |
| `CONNECT_FORBIDDEN`      | `CONNECT` rejected: `Blocked IP:`, `Blocked Host:` or `Blocked private target:` |
| `CONNECT_AUTH_FAIL`      | `CONNECT` with missing/wrong credentials                                 |
| `CONNECT_BAD_REQUEST`    | `CONNECT` target malformed                                               |
| `CONNECT_UPSTREAM_ERROR` | Tunnel connection failed or broke; details = `host:port CODE message`    |
| `CONNECT_TIMEDOUT`       | Tunnel idle for `CROSSFERRY_TIMEOUT_MS`                                             |
| `CONNECT_CLIENT_ERROR`   | Client socket error during a tunnel (usually the client disconnecting)   |
| `UTILS`                  | Internal: invalid status code passed to a helper, or a write failure     |

Startup and shutdown lines (`🔰`, `🔒`, `📛`, `✅`, `⚪`, `🛡️`, `🛑`) are always printed to stdout; `⛔` configuration errors always go to stderr.

# Security

What the proxy protects against, how, and what it leaves to you. Read this before exposing it to the internet.

- [Threat model](#threat-model)
- [Controls](#controls)
- [What is not covered](#what-is-not-covered)
- [Hardening checklist](#hardening-checklist)
- [Reporting issues](#reporting-issues)

---

## Threat model

A forward proxy is attractive to attackers for three reasons: it lends out your server's **IP address and bandwidth**, it may have **network access** your attacker does not (your LAN, cloud metadata, other containers), and it handles **credentials**.

| Threat                                                                                        | Control                                                       |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Strangers on the internet use the proxy (spam, scraping, attacks traced to your IP)           | Basic auth, IP allowlist, refuse-open-proxy startup check     |
| Operator misconfiguration silently leaves it open (e.g. wrong variable name)                  | Fatal startup validation; README/code variable names match    |
| Authenticated user reaches internal services: `localhost`, LAN, `169.254.169.254`, Docker peers | Private-address guard on literals **and** DNS results         |
| DNS rebinding: hostname resolves public at check time, private at connect time                | Check happens inside the `lookup` hook; one resolution only   |
| Proxy credentials leak to every website visited                                               | `Proxy-Authorization` stripped before forwarding              |
| Credential guessing by timing                                                                 | SHA-256 + `crypto.timingSafeEqual`; both fields always compared |
| Crashing the proxy with malformed requests (denial of service)                                | All input parsed and validated before use; tests cover each previously crashing case |
| Information leakage in error responses                                                        | Fixed error strings; internal messages only in logs           |
| Response corruption / smuggling via hop-by-hop headers                                        | RFC 9110 hop-by-hop set stripped both ways; Node re-frames bodies |
| Internal error text injected into a TLS tunnel                                                | After `200 Connection Established`, errors only close sockets |
| Resource exhaustion from abandoned requests                                                   | Idle timeouts; upstream requests cancelled when clients disconnect |

---

## Controls

### Authentication

`Proxy-Authorization: Basic base64(user:pass)`, checked on every request and every `CONNECT`. Credentials are split on the first `:` so passwords can contain colons. Both username and password are hashed with SHA-256 and compared with `crypto.timingSafeEqual`, and both comparisons always run, so response time does not reveal which field was wrong or how long the real values are.

A failure returns `407` with `Proxy-Authenticate: Basic realm="Proxy"`. Nothing else about the configuration is revealed.

### Client IP allowlist

Checked **first**, before auth. A client not on the list gets `403` and cannot tell whether auth is enabled, what hosts are allowed, or anything else. Matching is exact; see [configuration.md](configuration.md#crossferry_allowed_ips) for Docker caveats.

### Refuse-open-proxy check

At startup, if the proxy would listen on a non-loopback interface with no auth and no IP allowlist, it exits unless `CROSSFERRY_ALLOW_OPEN_PROXY=true`. This catches the most damaging misconfiguration: the one where everything "works" and the only sign is your server appearing on proxy lists a day later.

### Destination host allowlist

`CROSSFERRY_ALLOWED_HOSTS` restricts where authenticated users may go. It is evaluated before any DNS lookup. With wildcards (`*.example.com`) it can be kept short. Without it, an authenticated user can reach any public host and port.

### Private-address guard (SSRF)

Blocks loopback, RFC 1918, CGNAT, link-local (including the cloud metadata address `169.254.169.254`), multicast, reserved, and the IPv6 equivalents, both for IP-literal targets and for hostnames that resolve to such addresses.

The hostname check is done **inside** Node's `lookup` hook, so the socket connects to exactly the address that was approved. A hostname with mixed public and private records is blocked entirely. There is no window between the check and the connection in which DNS could change.

This matters most in Docker and cloud environments, where the proxy host can often reach things the outside world cannot: other containers on the same network, the Docker socket via TCP, database ports bound to the private interface, and the instance metadata service that hands out cloud credentials.

### Header hygiene

Hop-by-hop headers (`Connection`, `Keep-Alive`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`, and whatever `Connection` names) plus `Proxy-Authorization`, `Proxy-Authenticate` and `Proxy-Connection` are removed from forwarded requests and from returned responses. Node re-frames message bodies on the new connection, which removes the classic request-smuggling vector of conflicting `Content-Length`/`Transfer-Encoding` reaching the destination unchanged.

### Robustness

Every request path was tested against the inputs that crashed the original code (origin-form requests, `https://` request lines, upstream timeouts) and against client disconnects, mid-body upstream failures and malformed `CONNECT` targets. The test suite asserts the process is still alive after each.

### Runtime

The Docker image runs as the unprivileged `node` user, contains only `package.json`, `index.js` and `src/`, and has no package dependencies, so there is nothing to patch beyond Node itself.

---

## What is not covered

Be clear-eyed about these.

**Credentials and plain-HTTP traffic are visible between client and proxy.** The proxy port speaks plain HTTP. Basic Auth is base64, not encryption. Anyone on the network path between a client and the proxy (coffee-shop Wi-Fi, a hostile ISP) can read the password and any `http://` traffic. HTTPS *destinations* are still protected end to end by TLS inside the tunnel. Mitigations: use the proxy over networks you trust, or over a VPN/SSH tunnel; keep the password long and rotate it; prefer HTTPS destinations. Adding TLS on the proxy port itself is a candidate feature.

**The host's own public IP is not blocked.** `CROSSFERRY_BLOCK_PRIVATE_IPS` covers private ranges only. A request to `http://<your-public-ip>:8080/` goes through and reaches whatever listens there. Bind other services on the host to `127.0.0.1` or firewall them.

**Any port on allowed hosts.** There is no port allowlist. `CONNECT mail.example.com:25` works if the host is allowed. Add a port allowlist if your users should only reach web ports.

**One shared credential.** You cannot revoke one person's access without changing the password for everyone, and access logs cannot tell users apart.

**No rate limiting or quotas.** An authenticated user can saturate your bandwidth. Watch for this at the host or provider level.

**No URL filtering inside HTTPS.** The proxy sees only `host:port` for HTTPS. It cannot block specific pages, inspect content or scan for malware.

**Logs are the only audit trail**, and they are off by default. Turn on `CROSSFERRY_ENABLE_ERROR_LOGS` and `CROSSFERRY_ENABLE_ACCESS_LOGS` in production and ship them somewhere.

**`CROSSFERRY_ALLOW_OPEN_PROXY=true` means exactly that.** It exists for closed networks. On a public interface it will be found and abused within hours.

---

## Hardening checklist

Before exposing the proxy:

- [ ] `CROSSFERRY_AUTH_USER` / `CROSSFERRY_AUTH_PASS` set, password at least 24 random characters
- [ ] `CROSSFERRY_ALLOWED_IPS` set as well, if your clients have fixed addresses
- [ ] `CROSSFERRY_ALLOWED_HOSTS` set, if you know where users need to go
- [ ] `CROSSFERRY_BLOCK_PRIVATE_IPS` left at `true`, unless LAN access is the purpose (then rely on `CROSSFERRY_ALLOWED_HOSTS`)
- [ ] `CROSSFERRY_ALLOW_OPEN_PROXY` **not** set
- [ ] Other services on the host bound to `127.0.0.1` or firewalled, since the SSRF guard does not cover the host's public IP
- [ ] Host firewall allows inbound only on the proxy port (and SSH)
- [ ] `CROSSFERRY_ENABLE_ERROR_LOGS=true`, `CROSSFERRY_ENABLE_ACCESS_LOGS=true`, logs collected
- [ ] Running as a non-root user (the Docker image does this; for pm2/systemd, use a dedicated account)
- [ ] Node kept current (`node:24-alpine` image rebuilt periodically)
- [ ] Startup banner reviewed once after deploy: it prints the effective auth, allowlist and guard state

---

## Reporting issues

If you find a way to bypass any of the controls above, please report it privately to the maintainer rather than opening a public issue, and include a reproduction (a `curl` or raw request is ideal).

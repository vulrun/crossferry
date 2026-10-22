# Deployment

How to run the proxy for real: Docker (recommended), pm2, or systemd, plus networking, firewall and update notes.

- [Before you start](#before-you-start)
- [Docker Compose](#docker-compose)
- [Plain Docker](#plain-docker)
- [pm2](#pm2)
- [systemd](#systemd)
- [Networking](#networking)
- [Client IPs behind Docker](#client-ips-behind-docker)
- [Firewall](#firewall)
- [Updating](#updating)
- [Sizing](#sizing)

---

## Before you start

1. **Pick a host with a raw TCP port.** HTTPS proxying relies on the `CONNECT` method. HTTP-only load balancers and "web service" platforms (Vercel, Netlify, Render web services, Heroku, Cloud Run with HTTP ingress, most CDN proxies) will not forward it, and HTTPS sites will fail while plain HTTP works. A VPS, a bare-metal box, a home server with port forwarding, Fly.io, or a Railway TCP proxy all work.
2. **Create `.env`** from `.env.example` and set at least `CROSSFERRY_AUTH_USER`/`CROSSFERRY_AUTH_PASS` or `CROSSFERRY_ALLOWED_IPS`. The proxy will refuse to start otherwise (see [configuration.md](configuration.md#startup-validation)).
3. **Decide on the port.** 3128 is the convention. Some networks block it; 8080 or 443 are alternatives if your clients sit behind restrictive firewalls (443 needs root or a capability outside Docker).

---

## Docker Compose

This service ships `deploy/docker/Dockerfile` and `deploy/docker/docker-compose.yml` (the build context is the repository root). To run the forward proxy **and** the CORS proxy in one container, use the `Dockerfile`/`docker-compose.yml` at the repository root instead (see the root README).

```bash
cp .env.example .env    # edit it
npm run docker:up       # docker compose -f deploy/docker/docker-compose.yml up -d --build
npm run docker:logs
```

What the Compose file does:

| Setting                       | Why                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `env_file: .env`              | Your settings                                                                         |
| `environment: CROSSFERRY_HOST, CROSSFERRY_PORT`     | Forces `0.0.0.0:3128` inside the container so the published port works, whatever `.env` says |
| `ports: "3128:3128"`          | Publishes the proxy. Change the **left** number to use another external port          |
| `restart: unless-stopped`     | Survives reboots and crashes                                                          |
| `init: true`                  | A tiny init as PID 1 so signals reach Node and zombies are reaped                     |

What the image does:

- Based on `node:24-alpine`, about 50 MB.
- Copies only `package.json`, `index.js` and `src/`. No `npm install`, because there are no dependencies.
- Runs as the built-in unprivileged `node` user.
- `HEALTHCHECK` opens a TCP connection to the proxy port every 30 s. `docker ps` shows `healthy`/`unhealthy`.
- `docker compose stop` sends `SIGTERM`; the proxy closes idle connections immediately and force-exits after 8 s if tunnels are still open, within Docker's 10 s grace period.

Useful commands (export `COMPOSE_FILE=deploy/docker/docker-compose.yml` first, or add `-f deploy/docker/docker-compose.yml` to each):

```bash
docker compose ps                 # status and health
docker compose logs -f --tail 100 # logs (access on stdout, errors on stderr)
docker compose restart            # apply .env changes
docker compose down               # stop and remove
docker inspect --format '{{.State.Health.Status}}' $(docker compose ps -q proxy)
```

To bind only to localhost on the host (for example when an SSH tunnel is the intended way in), change the mapping to `"127.0.0.1:3128:3128"`.

---

## Plain Docker

```bash
docker build -f services/proxy/deploy/docker/Dockerfile -t crossferry-forward .   # from the repository root
docker run -d \
  --name crossferry-forward \
  --restart unless-stopped \
  --init \
  -p 3128:3128 \
  --env-file .env \
  -e CROSSFERRY_HOST=0.0.0.0 -e CROSSFERRY_PORT=3128 \
  crossferry-forward
docker logs -f crossferry-forward
```

The explicit `-e CROSSFERRY_HOST -e CROSSFERRY_PORT` after `--env-file` override anything in `.env`, mirroring what the Compose file does.

---

## pm2

For a VPS where you prefer running Node directly.

```bash
# as a dedicated user, in the repo directory
npm run pm2:start      # pm2 start index.js --name=crossferry-forward --node-args="--env-file-if-exists=.env"
pm2 save               # remember the process list
pm2 startup            # print the command that installs pm2 as a boot service; run it
```

Day to day:

```bash
npm run pm2:logs       # tail
npm run pm2:reload     # after editing .env or pulling new code
pm2 status
```

`--node-args` makes Node itself read `.env` on each start/reload, so no `export` dance is needed. If pm2 reports the process keeps restarting, the config validation is probably failing; `pm2 logs` shows the `⛔` line.

Run pm2 under a non-root account. Ports below 1024 then need `sudo setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))` or a port redirect.

---

## systemd

If you want neither Docker nor pm2, a unit file is enough. Save as `/etc/systemd/system/crossferry-forward.service`:

```ini
[Unit]
Description=Node.js forward HTTP/HTTPS proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=proxy
Group=proxy
WorkingDirectory=/opt/crossferry/services/proxy
EnvironmentFile=/opt/crossferry/services/proxy/.env
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=10

# sandboxing
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
# uncomment to bind ports below 1024 without root
# AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /opt/crossferry --shell /usr/sbin/nologin proxy
sudo chown -R proxy:proxy /opt/crossferry
sudo systemctl daemon-reload
sudo systemctl enable --now crossferry-forward
journalctl -u crossferry-forward -f
```

`EnvironmentFile` does **not** strip quotes the same way Node does; write values in `.env` without quotes when using systemd, or keep two files. `Restart=on-failure` deliberately does not restart on a clean exit code 1 loop from config validation forever; check `journalctl` if the service is inactive.

---

## Networking

- **Inbound**: only the proxy port.
- **Outbound**: the proxy needs to reach the internet on any port your users will use (at least 80 and 443) and to resolve DNS.
- **IPv6**: `CROSSFERRY_HOST=0.0.0.0` is IPv4 only. Use `CROSSFERRY_HOST=::` to accept IPv6 clients as well (Linux dual-stack). Destinations are resolved with IPv4 preferred.
- **Behind NAT at home**: forward the external port to the proxy host. Consider a non-default external port to reduce scanner noise; it is not a security measure.
- **Over SSH instead of the internet**: bind to `127.0.0.1` on the server, then `ssh -L 3128:127.0.0.1:3128 server` from the client and point the client at `localhost:3128`. This also encrypts the client-to-proxy leg, which plain HTTP does not.

---

## Client IPs behind Docker

`CROSSFERRY_ALLOWED_IPS` compares against the address the proxy's socket reports. With Docker's default bridge networking and port publishing on Linux, **IPv4** clients arrive with their real address (Docker uses iptables DNAT). The proxy may instead see Docker's gateway address (`172.17.0.1` or similar) when:

- the client connects over **IPv6** and Docker proxies it through its userland `docker-proxy`;
- Docker Desktop (macOS/Windows) is used;
- `userland-proxy` is enabled and the connection is from the host itself.

Check by enabling `CROSSFERRY_ENABLE_ERROR_LOGS` and reading the `Blocked IP:` line for a rejected request, or `CROSSFERRY_ENABLE_ACCESS_LOGS` for an accepted one. If you see a Docker address, either use `network_mode: host` in the Compose file (the container then shares the host network, and `ports:` is unnecessary) or rely on authentication instead of `CROSSFERRY_ALLOWED_IPS`.

---

## Firewall

With `ufw` on Ubuntu/Debian:

```bash
sudo ufw default deny incoming
sudo ufw allow OpenSSH
sudo ufw allow 3128/tcp
sudo ufw enable
```

Note that Docker manipulates iptables directly and **bypasses ufw** for published ports. The rules above are still right for everything else on the host, but a published Docker port is reachable regardless. Publish only the proxy port, and bind other containers' ports to `127.0.0.1` (`"127.0.0.1:5432:5432"`).

Keep host services off public interfaces: the proxy's private-address guard does not block the host's own public IP, so a database listening on `0.0.0.0:5432` is reachable through the proxy by any authenticated user.

---

## Updating

```bash
git pull
npm test                          # optional but quick
npm run docker:up                 # Docker (proxy alone); root: docker compose up -d --build
npm run pm2:reload                # pm2
sudo systemctl restart crossferry-forward # systemd
```

Rebuild the Docker image every few weeks even without code changes to pick up Node security patches (`docker compose build --pull`).

---

## Sizing

The proxy is a byte pump; CPU use is negligible and memory is roughly a few hundred KB per open connection on top of a ~40 MB Node baseline. A 1 vCPU / 512 MB VPS handles hundreds of concurrent tunnels. The practical limits are the host's bandwidth and open-file limit (`ulimit -n`; two sockets per tunnel). Raise `LimitNOFILE` in systemd or `ulimits` in Compose if you expect more than a few thousand simultaneous connections.

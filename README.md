# CrossFerry

**CrossFerry — a forward HTTP/HTTPS proxy and CORS proxy, runnable together or separately.**

| Service | Command | Runs on | What it does |
| ------- | ------- | ------- | ------------ |
| **Forward proxy** | `crossferry forward` | Node, Docker, VPS | HTTP/HTTPS proxy for browsers, phones and tools: `CONNECT` tunnels, Basic Auth, client and target allowlists, SSRF guard. [Docs →](services/proxy/README.md) |
| **CORS proxy** | `crossferry cors` | Node, Docker, Cloudflare Workers, AWS Lambda, Google Cloud Functions | cors-anywhere style: `GET /https://api.target/…` returns the target with CORS headers. [Docs →](services/cors/README.md) |
| **Both** | `crossferry all` (default) | Node, Docker, VPS | One process, two ports, one domain |

The forward proxy is Node-only by nature: it needs the `CONNECT` method and raw TCP tunnels, which serverless HTTP platforms never deliver. The CORS proxy is plain request → response and ships with an adapter per platform.

- [Install](#install)
- [Usage](#usage)
- [Configuration](#configuration)
- [Docker](#docker)
- [Serverless (CORS proxy only)](#serverless-cors-proxy-only)
- [Repository layout](#repository-layout)
- [Testing and CI](#testing-and-ci)
- [License](#license)

---

## Install

Requires Node.js 22.12 or newer.

```bash
git clone <this repo> crossferry && cd crossferry
npm install                      # sets up the npm workspace; no build step
cp .env.example .env             # set CROSSFERRY_AUTH_USER / CROSSFERRY_AUTH_PASS at minimum
```

`npm install` links the `crossferry` command inside the repo (`npx crossferry …`). To have it on your `PATH`, run `npm link` once, or use the Docker image below.

---

## Usage

```bash
crossferry            # both services (same as `crossferry all`)
crossferry forward    # forward HTTP/HTTPS proxy only, on CROSSFERRY_PORT (3128)
crossferry cors       # CORS proxy only, on CROSSFERRY_CORS_PORT (8080)
crossferry --help     # usage and the environment rules
crossferry --version
```

npm equivalents load `.env` for you: `npm start` (all), `npm run start:forward`, `npm run start:cors`, `npm run dev` (restart on change).

```
🔰 CrossFerry forward proxy listening on 0.0.0.0:3128
🔒 Basic Auth enabled
…
🔰 CrossFerry CORS proxy listening on 0.0.0.0:8080
…
🧩 CrossFerry running: forward on :3128, cors on :8080
```

Smoke test:

```bash
curl -x http://alice:secret@localhost:3128 https://ifconfig.me                 # forward proxy
curl -H "Origin: https://my.app" http://localhost:8080/https://example.com/    # CORS proxy
```

A configuration error in either service stops the whole process with a `⛔ [forward] …` or `⛔ [cors] …` line and exit code 1, so a half-running deployment cannot happen. `SIGTERM`/`SIGINT` shut both services down cleanly.

---

## Configuration

Everything is an environment variable with the `CROSSFERRY_` prefix, on every platform (Node, Docker, Workers `[vars]`, Lambda parameters, Cloud Functions `env.yaml`):

| Form | Applies to | Example |
| ---- | ---------- | ------- |
| `CROSSFERRY_<NAME>` | every service that understands `<NAME>` | `CROSSFERRY_HOST`, `CROSSFERRY_BLOCK_PRIVATE_IPS`, `CROSSFERRY_AUTH_USER` (forward only), `CROSSFERRY_ALLOWED_ORIGINS` (CORS only) |
| `CROSSFERRY_FORWARD_<NAME>` | forward proxy only, wins over the shared value | `CROSSFERRY_FORWARD_ALLOWED_HOSTS` |
| `CROSSFERRY_CORS_<NAME>` | CORS proxy only, wins over the shared value | `CROSSFERRY_CORS_ENABLE_ACCESS_LOGS` |
| `CROSSFERRY_PORT` / `CROSSFERRY_CORS_PORT` | the forward proxy's port / the CORS proxy's port | `3128` / `8080` |
| `CROSSFERRY_FORWARD_ENABLED=false` / `CROSSFERRY_CORS_ENABLED=false` | skips a service under `crossferry all` | |

Variables without the prefix are ignored. `.env.example` is a commented starting point; the per-service `.env.example` files list every setting.

### Shared

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `CROSSFERRY_HOST` | `0.0.0.0` | Interface to listen on (`127.0.0.1` = this machine only) |
| `CROSSFERRY_BLOCK_PRIVATE_IPS` | `true` | Refuse loopback, private, link-local and cloud-metadata targets, also at DNS time |
| `CROSSFERRY_ALLOWED_HOSTS` | (any) | Target hosts either service may reach: exact or `*.example.com` |
| `CROSSFERRY_ENABLE_ACCESS_LOGS` | `false` | One stdout line per proxied request |
| `CROSSFERRY_ENABLE_ERROR_LOGS` | `false` | Rejections and upstream failures on stderr |

### Forward proxy ([full reference](services/proxy/docs/configuration.md))

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `CROSSFERRY_PORT` | `3128` | Listening port |
| `CROSSFERRY_AUTH_USER`, `CROSSFERRY_AUTH_PASS` | (empty) | Basic Auth; set both or neither |
| `CROSSFERRY_ALLOWED_IPS` | (any) | Client IPs allowed to use the proxy, exact match |
| `CROSSFERRY_ALLOW_OPEN_PROXY` | `false` | Permit a public listener with neither auth nor an IP allowlist |
| `CROSSFERRY_TIMEOUT_MS` | `60000` | Idle timeout for upstream requests and tunnels |

### CORS proxy ([full reference](services/cors/README.md#configuration))

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `CROSSFERRY_CORS_PORT` | `8080` | Listening port |
| `CROSSFERRY_REQUIRE_HEADERS` | `origin,x-requested-with` | A request must carry one of these; empty disables |
| `CROSSFERRY_ALLOWED_ORIGINS` | (any) | Origins allowed to use the service; reflected instead of `*` when set |
| `CROSSFERRY_BLOCKED_ORIGINS` | (none) | Origins refused |
| `CROSSFERRY_ALLOWED_PORTS` | `80,443` | Target ports |
| `CROSSFERRY_RATE_LIMIT` | (off) | `"<requests> <minutes> [exempt hosts]"` per origin host |
| `CROSSFERRY_RATE_LIMIT_EXEMPT` | (none) | Extra exemptions, hosts or `/regex/` |
| `CROSSFERRY_MAX_REDIRECTS` | `5` | 301/302/303 hops to follow |
| `CROSSFERRY_UPSTREAM_TIMEOUT_MS` | `30000` | Wait for response headers |
| `CROSSFERRY_CORS_MAX_AGE` | `600` | Preflight cache seconds |
| `CROSSFERRY_REMOVE_HEADERS` | `cookie,cookie2` | Request headers dropped before forwarding |
| `CROSSFERRY_SET_HEADERS` | (none) | `name: value; name2: value2` added to forwarded requests |
| `CROSSFERRY_REDIRECT_SAME_ORIGIN` | `false` | Answer same-origin targets with a 301 instead of proxying |
| `CROSSFERRY_PUBLIC_BASE_URL` | (derived) | Base for rewritten `Location` headers behind a custom domain |

---

## Docker

```bash
cp .env.example .env
docker compose up -d --build        # both services; or: npm run docker:up
docker compose logs -f
```

The root `Dockerfile` builds a `node:24-alpine` image whose entrypoint is the CLI, so one image runs any mode:

```bash
docker build -t crossferry .
docker run -d --init -p 3128:3128 -p 8080:8080 --env-file .env -e CROSSFERRY_HOST=0.0.0.0 crossferry          # all
docker run -d --init -p 8080:8080 --env-file .env -e CROSSFERRY_HOST=0.0.0.0 crossferry cors                    # one service
```

It runs as a non-root user and has a health check that probes exactly the services the CLI started. `docker compose stop` shuts them down cleanly within 8 seconds. Single-service images with smaller footprints live in `services/proxy/deploy/docker/` and `services/cors/deploy/docker/`.

### Prebuilt images (GitHub Container Registry)

CI publishes three images on every push to `main` (`latest`, `main`, `sha-<commit>`) and on version tags, for `linux/amd64` and `linux/arm64`:

| Image | Contents | Semver tags come from |
| ----- | -------- | --------------------- |
| `ghcr.io/<owner>/crossferry` | both services, CLI entrypoint | `v1.2.3` → `1.2.3`, `1.2` |
| `ghcr.io/<owner>/crossferry-forward` | forward proxy only | `forward-v1.2.3` |
| `ghcr.io/<owner>/crossferry-cors` | CORS proxy only | `cors-v1.2.3` |

```bash
docker run -d --name crossferry --restart unless-stopped --init \
  -p 3128:3128 -p 8080:8080 --env-file .env -e CROSSFERRY_HOST=0.0.0.0 \
  ghcr.io/<owner>/crossferry:latest

CROSSFERRY_IMAGE=ghcr.io/<owner>/crossferry:latest docker compose up -d --no-build
```

A package is private when first published; make it public under the repository's *Packages* settings or pull with a token that has `read:packages`.

### pm2

```bash
npm run pm2:start                   # pm2 start bin/crossferry.js --name crossferry -- all
pm2 save && pm2 startup
```

---

## Serverless (CORS proxy only)

The CORS proxy deploys to Cloudflare Workers, AWS Lambda (streaming Function URL) and Google Cloud Functions with the same `CROSSFERRY_*` settings; see [services/cors/README.md](services/cors/README.md#deploying). The forward proxy needs raw TCP and is not available there; run the `crossferry` image on a host with TCP ports (VPS, Fly.io, Railway TCP) if you need both.

---

## Repository layout

```
bin/crossferry.js             the CLI (forward | cors | all)
index.js                      CLI implementation: service registry, env rules, lifecycle
healthcheck.js                Docker health check for the crossferry image
Dockerfile, docker-compose.yml   both services in one container
.env.example                  starting point for settings
package.json                  npm workspace root (packages/*, services/*), `crossferry` bin
packages/shared/              @crossferry/shared: CROSSFERRY_* env rules, IP ranges, allowlists, header hygiene
services/proxy/               @crossferry/proxy: forward proxy, its docs/, tests, single-service Dockerfile (Node only)
services/cors/                @crossferry/cors: CORS proxy, adapters for Node/Workers/Lambda/GCF, deploy/, tests
.github/workflows/            CI (tests, bundles, three Docker images to ghcr.io) and CORS deploys
LICENSE                       MIT
```

---

## Testing and CI

```bash
npm test                            # every suite: CLI, shared, forward proxy, CORS proxy
npm test -w @crossferry/cors        # one package
```

No test needs network access; each suite starts its own local upstreams. `.github/workflows/ci.yml` runs the suites, builds the serverless bundles, dry-runs the Workers deploy and builds the three Docker images on every push and pull request, publishing them to ghcr.io on `main` and on `v*` / `forward-v*` / `cors-v*` tags. `.github/workflows/deploy-cors.yml` deploys the CORS proxy to Workers, Lambda or Cloud Functions on a `cors-v*` tag or by hand.

---

## License

MIT — see [LICENSE](LICENSE).

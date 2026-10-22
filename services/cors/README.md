# CrossFerry CORS proxy

A [cors-anywhere](https://github.com/Rob--W/cors-anywhere)-style service: prefix any URL with this service's address and the response comes back with CORS headers, so browser code can call APIs that don't allow cross-origin requests.

```js
const res = await fetch("https://cors.example.com/https://api.target.com/v1/items?limit=10");
```

The core is a plain `Request → Response` function with no framework or Node dependencies, so the same code runs on **Node, Docker, Cloudflare Workers, AWS Lambda and Google Cloud Functions**, with a thin adapter per platform.

- [Quick start](#quick-start)
- [How requests work](#how-requests-work)
- [Configuration](#configuration)
- [Deploying](#deploying)
- [Platform notes and limits](#platform-notes-and-limits)
- [Security](#security)
- [Differences from cors-anywhere](#differences-from-cors-anywhere)
- [Development](#development)

---

## Quick start

From the repository root (Node 22.9+):

```bash
npm install
cp services/cors/.env.example services/cors/.env   # optional; defaults are safe
npm start -w @crossferry/cors                            # http://localhost:8080
```

```bash
curl -i -H "Origin: https://my.app" http://localhost:8080/https://example.com/
curl -i http://localhost:8080/https://example.com/        # 400: no Origin / X-Requested-With
curl -i -X OPTIONS -H "Origin: https://my.app" -H "Access-Control-Request-Method: PUT" http://localhost:8080/https://example.com/
```

To run it together with the forward proxy in one process, use `crossferry all` from the repository root (`npm start` there). See the [root README](../../README.md).

---

## How requests work

### Target URL

The target is the request path minus the leading `/`, plus the query string:

| Request path                                   | Fetched                              |
| ---------------------------------------------- | ------------------------------------ |
| `/https://api.test/v1/items?limit=10`          | `https://api.test/v1/items?limit=10` |
| `/api.test/page`                               | `http://api.test/page` (no scheme → http) |
| `/api.test:443/page`                           | `https://api.test/page` (port 443 → https) |
| `/https:/api.test/x` (slashes collapsed by a platform) | `https://api.test/x`         |
| `/ftp://…`, `/https://user:pw@host/`           | `400`                                |

Built-in paths: `/` usage text, `/healthz` → `ok`, `/iscorsneeded` → `no`, `/favicon.ico` → 404.

### Checks, in order

Every rejection is `text/plain` **with CORS headers**, so the calling page can read the message.

| #   | Check                                                             | Status |
| --- | ----------------------------------------------------------------- | ------ |
| 0   | `OPTIONS` preflight: answered immediately, before any check       | 200    |
| 1   | At least one of `CROSSFERRY_REQUIRE_HEADERS` present (default `Origin` or `X-Requested-With`) | 400 |
| 2   | `Origin` matches `CROSSFERRY_BLOCKED_ORIGINS`                                | 403    |
| 3   | `CROSSFERRY_ALLOWED_ORIGINS` set and `Origin` not in it                      | 403    |
| 4   | Rate limit exceeded for this origin                               | 429    |
| 5   | Target scheme not http/https                                      | 400    |
| 6   | Target port not in `CROSSFERRY_ALLOWED_PORTS`                                | 403    |
| 7   | Target host not in `CROSSFERRY_ALLOWED_HOSTS` (when set)                     | 403    |
| 8   | Target is loopback/private/link-local, or `localhost` (`CROSSFERRY_BLOCK_PRIVATE_IPS`) | 403 |
| 9   | `CROSSFERRY_REDIRECT_SAME_ORIGIN` and the target is the caller's own origin  | 301 to the target |

Checks 5–8 run again for every redirect hop.

### What is forwarded

- Method, body (streamed) and headers, **minus**: hop-by-hop headers, `Host`, `Cookie`/`Cookie2` (`CROSSFERRY_REMOVE_HEADERS`), `Accept-Encoding`, and anything that identifies the client or platform (`X-Forwarded-*`, `CF-*`, `X-Real-IP`, `Forwarded`, `Via`, `X-Amzn-*`, `X-Cloud-Trace-Context`, `X-Appengine-*`). `CROSSFERRY_SET_HEADERS` are added. `Origin` is passed through unchanged, like cors-anywhere.
- The target sees this service's IP, never the browser's.

### What comes back

The target's status, status text, headers and body (streamed), with these changes:

| Header                                   | Behaviour                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `Access-Control-Allow-Origin`            | `*`, or the caller's origin when `CROSSFERRY_ALLOWED_ORIGINS` is set (plus `Vary: Origin`) |
| `Access-Control-Expose-Headers`          | every header name in the response, so scripts can read them all           |
| `X-Request-URL`                          | the URL that was asked for                                                |
| `X-Final-URL`                            | the URL that answered, after redirects                                    |
| `X-CORS-Redirect-N`                      | `<status> <url>` for each followed hop                                    |
| `Set-Cookie`, `Set-Cookie2`              | removed                                                                   |
| target's own `Access-Control-*`          | removed (ours replace them)                                               |
| `Content-Encoding`, `Content-Length`     | removed when the target compressed the body: the runtime has already decoded it |
| hop-by-hop headers                       | removed                                                                   |

Preflight responses add `Access-Control-Allow-Methods` (echoing `Access-Control-Request-Method`, else all methods), `Access-Control-Allow-Headers` (echoing the request, else `*`) and `Access-Control-Max-Age`. Credentials are never allowed.

### Redirects

- `301`, `302`, `303`: followed, as a `GET` without the body, up to `CROSSFERRY_MAX_REDIRECTS` (5). Each hop is re-checked against the port, host and private-address rules.
- `307`, `308`, and anything past the limit: returned to the client with `Location` rewritten to `<this service>/<absolute target>`, so the browser follows through the proxy again. The base is `CROSSFERRY_PUBLIC_BASE_URL` if set, otherwise derived from the request (`X-Forwarded-Proto`/`X-Forwarded-Host` are honoured).

### Failures

`504` when the target sends no headers within `CROSSFERRY_UPSTREAM_TIMEOUT_MS` (a slow but flowing body is never cut), `502` when it cannot be reached at all.

---

## Configuration

All settings are `CROSSFERRY_*` environment variables with the same names on every platform; `CROSSFERRY_CORS_<NAME>` is accepted too and wins when both services run from one environment. On Node they come from `.env` (see `.env.example`); on Workers from `[vars]` in `wrangler.toml`; on Lambda from the SAM template parameters; on Cloud Functions from `deploy/gcf/env.yaml`.

| Variable               | Default                      | Description                                                                                   |
| ---------------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| `CROSSFERRY_CORS_PORT`, `CROSSFERRY_HOST`         | `8080`, `0.0.0.0`            | Node adapter only                                                                             |
| `CROSSFERRY_REQUIRE_HEADERS`      | `origin,x-requested-with`    | A request must carry one of these. Empty disables the check                                   |
| `CROSSFERRY_ALLOWED_ORIGINS`      | (empty = any)                | `https://app.example.com,https://*.example.com`. When set, the matching origin is reflected instead of `*` |
| `CROSSFERRY_BLOCKED_ORIGINS`      | (empty)                      | Same syntax; checked first                                                                    |
| `CROSSFERRY_ALLOWED_HOSTS`        | (empty = any)                | Target hosts: exact or `*.example.com` (subdomains only)                                      |
| `CROSSFERRY_ALLOWED_PORTS`        | `80,443`                     | Target ports. Empty = any                                                                     |
| `CROSSFERRY_BLOCK_PRIVATE_IPS`    | `true`                       | Refuse loopback, RFC 1918, CGNAT, link-local (incl. cloud metadata), multicast; also at DNS time on Node/Lambda/GCF |
| `CROSSFERRY_RATE_LIMIT`           | (empty = off)                | `"<requests> <minutes> [exempt hosts…]"` per origin host, fixed window, cors-anywhere syntax   |
| `CROSSFERRY_RATE_LIMIT_EXEMPT`    | (empty)                      | More exemptions: hosts or `/regex/`, space-separated                                          |
| `CROSSFERRY_MAX_REDIRECTS`        | `5`                          | `0` disables following                                                                        |
| `CROSSFERRY_UPSTREAM_TIMEOUT_MS`  | `30000`                      | Wait for response headers                                                                     |
| `CROSSFERRY_CORS_MAX_AGE`         | `600`                        | Preflight cache seconds; `0` omits the header                                                 |
| `CROSSFERRY_REMOVE_HEADERS`       | `cookie,cookie2`             | Request headers dropped before forwarding                                                     |
| `CROSSFERRY_SET_HEADERS`          | (empty)                      | `x-powered-by: CrossFerry; x-other: v` set on forwarded requests                                    |
| `CROSSFERRY_REDIRECT_SAME_ORIGIN` | `false`                      | Answer same-origin targets with a 301 instead of proxying                                     |
| `CROSSFERRY_PUBLIC_BASE_URL`      | (derived)                    | Base used in rewritten `Location` headers, e.g. behind CloudFront                             |
| `CROSSFERRY_ENABLE_ACCESS_LOGS`   | `false`                      | One stdout line per proxied request (method, target, origin). Never bodies or cookies          |
| `CROSSFERRY_ENABLE_ERROR_LOGS`    | `false`                      | Rejections and upstream failures on stderr                                                    |

Malformed `CROSSFERRY_RATE_LIMIT`, `CROSSFERRY_ALLOWED_PORTS`, `CROSSFERRY_SET_HEADERS` or an invalid exemption regex make startup fail with a message.

---

## Deploying

All commands run from `services/cors` unless noted. Platform credentials are never stored in the repo.

### Docker

From the **repository root** (the image needs `packages/shared`):

```bash
docker compose -f services/cors/deploy/docker/docker-compose.yml up -d --build
# or
docker build -f services/cors/deploy/docker/Dockerfile -t crossferry-cors .
docker run -d -p 8080:8080 --env-file services/cors/.env -e CROSSFERRY_HOST=0.0.0.0 -e CROSSFERRY_CORS_PORT=8080 --init crossferry-cors
```

`node:24-alpine`, non-root, `/healthz` health check, clean shutdown on `SIGTERM`.

Prebuilt by CI as `ghcr.io/<owner>/crossferry-cors` (`latest` from `main`, semver from `cors-v*` tags, amd64 + arm64): use that name in place of `crossferry-cors` above, or `CROSSFERRY_CORS_IMAGE=ghcr.io/<owner>/crossferry-cors:latest docker compose -f services/cors/deploy/docker/docker-compose.yml up -d --no-build`. See the [root README](../../README.md#prebuilt-images-github-container-registry) for registry access.

### Cloudflare Workers

```bash
npx wrangler login              # once
npm run dev:workers             # http://localhost:8787
npm run deploy:workers
```

Config lives in `deploy/workers/wrangler.toml` (`[vars]`). Add a custom domain there or in the dashboard. The Workers platform refuses fetches to private addresses on its own, which backs up the service's literal checks.

### AWS Lambda (Function URL, response streaming)

Needs the [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/) and AWS credentials.

```bash
npm run build                   # bundles dist/lambda/lambda.mjs (undici included, ~1 MB)
sam deploy -t deploy/lambda/template.yaml --config-file deploy/lambda/samconfig.toml \
  --parameter-overrides AllowedOrigins=https://app.example.com
```

The template creates one `nodejs22.x` function with a public Function URL in `RESPONSE_STREAM` mode, so large bodies are streamed instead of hitting the 6 MB buffered limit. Settings are template parameters (`--parameter-overrides`). The exported `handler` streams inside Lambda; `bufferedHandler` exists for API Gateway if you front it that way.

### Google Cloud Functions (gen2)

Needs the `gcloud` CLI with a project selected.

```bash
npm run dev:gcf                 # Functions Framework on http://localhost:8080
GCP_PROJECT=my-project GCP_REGION=us-central1 npm run deploy:gcf
```

Settings are in `deploy/gcf/env.yaml`. The deploy script uploads `dist/gcf/` (bundle + a tiny `package.json` that depends only on the Functions Framework).

### GitHub Actions

`.github/workflows/deploy-cors.yml` deploys on a `cors-v*` tag or by hand (`workflow_dispatch`, choose the target). Required repository settings:

| Target  | Secrets                                                           | Variables       |
| ------- | ----------------------------------------------------------------- | --------------- |
| Workers | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`                   |                 |
| Lambda  | `AWS_ROLE_TO_ASSUME` (OIDC role with CloudFormation/Lambda/S3/IAM rights) | `AWS_REGION` |
| GCF     | `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`           | `GCP_PROJECT`, `GCP_REGION` |

---

## Platform notes and limits

| Platform        | Streaming | Request/response size                            | Time limit        | Notes                                                                 |
| --------------- | --------- | ------------------------------------------------ | ----------------- | --------------------------------------------------------------------- |
| Node / Docker   | yes       | none                                             | none              | DNS-pinned SSRF check; in-memory rate limit per process               |
| Workers         | yes       | 100 MB request body                              | CPU time per plan | Free plan: 100k requests/day. Rate limit state is per isolate; use Cloudflare's own rate-limiting rules for real enforcement |
| Lambda (URL)    | yes       | 6 MB request; streamed responses up to 20 MB     | 15 min max        | Rate limit state is per instance; use WAF/API Gateway throttling. Cold start ~200 ms |
| Cloud Functions | yes       | 32 MB request                                    | 60 min max        | Rate limit state is per instance; use Cloud Armor                     |

On every platform the memory rate limiter protects a single instance only. Treat it as a speed bump, and put the platform's edge rate limiting in front for a public deployment.

---

## Security

An open CORS proxy is an open proxy for web traffic. The defaults are the cors-anywhere defaults plus a few guards; tighten them for anything public.

- **Require a header** (`CROSSFERRY_REQUIRE_HEADERS`): browsers always send `Origin` on cross-origin requests; scripts and crawlers usually don't bother, which filters most casual abuse. It is not authentication.
- **Origin allowlist** (`CROSSFERRY_ALLOWED_ORIGINS`): the real access control. Only your own sites get a usable `Access-Control-Allow-Origin`; everyone else gets 403.
- **Target allowlist** (`CROSSFERRY_ALLOWED_HOSTS`): if your app only needs two APIs, list them. Then the service cannot be used to reach anything else.
- **Private-address guard**: refuses `127.0.0.1`, `10.x`, `192.168.x`, `172.16–31.x`, `169.254.169.254` (cloud metadata), IPv6 equivalents and `localhost`, both as literals and as DNS results on the Node-based runtimes (the connect-time lookup hook means the socket goes to the address that was checked, so DNS rebinding cannot slip past). It does **not** block the host's own public IP.
- **Ports**: 80 and 443 only by default, so the service cannot be pointed at SMTP, Redis or SSH on an otherwise public host.
- **Cookies** never cross the proxy in either direction, and `Access-Control-Allow-Credentials` is never sent.
- **Rate limit**: per-origin, in memory. See the platform table above.
- The target never learns the browser's IP; the service never learns more than it logs (no bodies, no cookies).

---

## Differences from cors-anywhere

| Topic                 | cors-anywhere                           | This service                                                         |
| --------------------- | --------------------------------------- | -------------------------------------------------------------------- |
| Proxy error           | `404 Not found because of proxy error`  | `502 Bad Gateway`; `504` on timeout                                  |
| `http:/host` (one slash) | `400 Missing slash`                  | normalized and accepted (some platforms collapse `//`)               |
| Target ports          | any                                     | `CROSSFERRY_ALLOWED_PORTS`, default 80 and 443                                  |
| Private targets       | allowed                                 | refused by default (`CROSSFERRY_BLOCK_PRIVATE_IPS`)                             |
| Compressed responses  | passed through as-is                    | served decoded; `Content-Encoding` removed                           |
| `Access-Control-Allow-Headers` | echoes the request only        | echoes the request, else `*`                                         |
| Extra endpoints       | `/iscorsneeded`                         | plus `/healthz`                                                      |
| `getProxyForUrl`, `httpsOptions`, `handleInitialRequest` | supported | not supported (put TLS and routing in the platform)        |
| Runtimes              | Node                                    | Node, Docker, Workers, Lambda, Cloud Functions                       |

Everything else — URL format, header names, redirect behaviour, rate-limit syntax, `requireHeader`, origin lists, `redirectSameOrigin` — matches.

---

## Development

```
src/app.js            createApp(config, { fetchImpl, rateLimiter, now }) → { fetch(request) }
src/config.js         loadConfig(env)
src/target.js         path → target URL
src/cors.js           CORS / preflight headers
src/policy.js         the checks table above
src/forward.js        header hygiene, redirects, response shaping
src/rate-limit.js     in-memory fixed-window limiter
src/adapters/         node.js, workers.js, lambda.js, gcf.js, lookup.js (DNS guard)
deploy/               docker/, workers/, lambda/, gcf/
scripts/build.mjs     esbuild bundles for Lambda and Cloud Functions
test/                 core (in-process, stubbed fetch), node (real server), lambda (sample event), gcf (fake Express req/res)
```

```bash
npm test -w @crossferry/cors        # all four suites, no network needed
npm run build -w @crossferry/cors   # dist/lambda, dist/gcf
```

The core takes `fetchImpl` and `now` so tests never touch the network or the clock. To add a check, extend `checkPolicy`/`checkTarget` in `policy.js`, document it in the table above, and add an allowed and a denied case to `test/core.test.js`.

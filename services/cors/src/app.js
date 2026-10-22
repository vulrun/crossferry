import { createLogger } from "@crossferry/shared";
import { parseTarget } from "./target.js";
import { corsHeaders, preflightHeaders } from "./cors.js";
import { checkPolicy, checkTarget, PolicyError } from "./policy.js";
import { forward } from "./forward.js";
import { createMemoryRateLimiter } from "./rate-limit.js";
import { HELP_TEXT } from "./help.js";

export { loadConfig } from "./config.js";

// Builds the platform-independent handler. Adapters call `fetch(request)`; tests inject fetchImpl/now.
export function createApp(config, { fetchImpl = globalThis.fetch, rateLimiter, logger, now = Date.now } = {}) {
  const limiter = rateLimiter ?? (config.RATE_LIMIT ? createMemoryRateLimiter({ ...config.RATE_LIMIT, now }) : null);
  const log = logger ?? createLogger({ access: config.ENABLE_ACCESS_LOGS, errors: config.ENABLE_ERROR_LOGS });

  async function fetch(request) {
    const requestUrl = new URL(request.url);
    const cors = corsHeaders(request, config);
    const origin = request.headers.get("origin") || "-";

    const text = (status, message, extra = {}) =>
      new Response(message, {
        status,
        headers: mergeHeaders(cors, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra }),
      });

    // answered before any check, like cors-anywhere, so browsers can at least read our errors
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: preflightHeaders(request, config) });
    }

    const target = parseTarget(requestUrl.pathname, requestUrl.search);
    switch (target.route) {
      case "help":
        return text(200, HELP_TEXT);
      case "iscorsneeded":
        return new Response("no", { status: 200, headers: { "content-type": "text/plain" } });
      case "healthz":
        return text(200, "ok");
      case "favicon":
        return text(404, "Not Found");
    }

    if (target.error) {
      log.error("BAD_REQUEST", requestUrl.pathname, "from", origin);
      return text(400, target.error);
    }

    const problem = await checkPolicy(request, target, config, limiter);
    if (problem) {
      log.error("REJECTED", problem.status, target.url.href, "from", origin, "-", problem.message);
      return text(problem.status, problem.message);
    }

    if (config.REDIRECT_SAME_ORIGIN && origin !== "-" && target.url.origin === origin) {
      return new Response(null, {
        status: 301,
        headers: mergeHeaders(cors, { location: target.url.href, vary: "Origin", "cache-control": "private" }),
      });
    }

    log.access("CORS", request.method, target.url.href, "from", origin);

    try {
      return await forward(request, target, config, {
        fetchImpl,
        cors,
        publicBase: publicBase(requestUrl, request, config),
        recheck: (url) => checkTarget(url, config),
      });
    } catch (err) {
      if (err instanceof PolicyError) {
        log.error("REJECTED", err.status, target.url.href, "redirect", "-", err.message);
        return text(err.status, err.message);
      }
      // the Node adapters' DNS hook refuses private results with this code
      if (err.cause?.code === "EBLOCKED") {
        log.error("REJECTED", 403, target.url.href, "dns", "-", err.cause.message);
        return text(403, "Forbidden: private address not allowed");
      }
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        log.error("UPSTREAM_TIMEOUT", target.url.href);
        return text(504, "Gateway Timeout: the target did not respond in time");
      }
      log.error("UPSTREAM_ERROR", target.url.href, err.cause?.code || err.code || err.name, err.message);
      return text(502, "Bad Gateway: could not reach the target");
    }
  }

  return { fetch, config };
}

// the address clients should use to come back through this service (for rewritten Location headers)
function publicBase(requestUrl, request, config) {
  if (config.PUBLIC_BASE_URL) return config.PUBLIC_BASE_URL;
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() || requestUrl.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host")?.split(",")[0].trim() || requestUrl.host;
  return `${proto}://${host}`;
}

function mergeHeaders(base, extra) {
  const headers = new Headers(base);
  for (const [name, value] of Object.entries(extra)) {
    if (name.toLowerCase() === "vary") headers.append(name, value);
    else headers.set(name, value);
  }
  return headers;
}

import { isOriginAllowed } from "@crossferry/shared";

const DEFAULT_METHODS = "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS";

// "*" when any origin is allowed, the request's own origin when it matches the allowlist, else null
export function resolveAllowOrigin(origin, config) {
  if (!config.ALLOWED_ORIGINS.length) return "*";
  if (origin && isOriginAllowed(origin, config.ALLOWED_ORIGINS)) return origin;
  return null;
}

// headers every response carries (proxied, error or help)
export function corsHeaders(request, config) {
  const headers = new Headers();
  const allow = resolveAllowOrigin(request.headers.get("origin"), config);
  if (allow) headers.set("access-control-allow-origin", allow);
  // a reflected origin makes the response origin-specific; tell caches
  if (allow && allow !== "*") headers.set("vary", "Origin");
  return headers;
}

// extra headers for an OPTIONS preflight
export function preflightHeaders(request, config) {
  const headers = corsHeaders(request, config);
  headers.set("access-control-allow-methods", request.headers.get("access-control-request-method") || DEFAULT_METHODS);
  // "*" does not cover Authorization, so echo the requested list when there is one
  headers.set("access-control-allow-headers", request.headers.get("access-control-request-headers") || "*");
  if (config.MAX_AGE > 0) headers.set("access-control-max-age", String(config.MAX_AGE));
  return headers;
}

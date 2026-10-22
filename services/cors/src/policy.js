import { isOriginAllowed, isHostAllowed, isPrivateAddress, isLocalHostname } from "@crossferry/shared";
import { targetPort } from "./target.js";

// a rejection the caller turns into a plain-text response
export class PolicyError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "PolicyError";
    this.status = status;
  }
}

// cors-anywhere order: required header → blocked origin → allowed origin → rate limit → target rules
export async function checkPolicy(request, target, config, rateLimiter) {
  const origin = request.headers.get("origin") || "";

  if (config.REQUIRE_HEADERS.length && !config.REQUIRE_HEADERS.some((name) => request.headers.has(name))) {
    return new PolicyError(400, `Missing required request header. Must specify one of: ${config.REQUIRE_HEADERS.join(", ")}`);
  }

  if (origin && config.BLOCKED_ORIGINS.length && isOriginAllowed(origin, config.BLOCKED_ORIGINS)) {
    return new PolicyError(403, "Forbidden: origin is blocked");
  }

  if (config.ALLOWED_ORIGINS.length && !(origin && isOriginAllowed(origin, config.ALLOWED_ORIGINS))) {
    return new PolicyError(403, "Forbidden: origin not allowed");
  }

  if (rateLimiter) {
    const message = await rateLimiter.check(originHost(origin));
    if (message) return new PolicyError(429, message);
  }

  return checkTarget(target.url, config);
}

// rules that apply to the initial target and to every redirect hop
export function checkTarget(url, config) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return new PolicyError(400, "Bad Request: only http and https targets are supported");
  }

  const port = targetPort(url);
  if (config.ALLOWED_PORTS.length && !config.ALLOWED_PORTS.includes(port)) {
    return new PolicyError(403, `Forbidden: port ${port} is not allowed`);
  }

  if (!isHostAllowed(url.hostname, config.ALLOWED_HOSTS)) {
    return new PolicyError(403, "Forbidden: host not allowed by allowlist");
  }

  if (config.BLOCK_PRIVATE_IPS) {
    const bare = url.hostname.replace(/^\[|\]$/g, "");
    if (isPrivateAddress(bare) || isLocalHostname(bare)) {
      return new PolicyError(403, "Forbidden: private address not allowed");
    }
  }

  return null;
}

// rate-limit key: the origin's host (with port), "-" when the request has no Origin
export function originHost(origin) {
  if (!origin) return "-";
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return origin.replace(/^[a-z]+:\/\//i, "").toLowerCase();
  }
}

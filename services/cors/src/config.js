import { splitStr, parsePositiveInt, parseBool } from "@crossferry/shared";

const lower = (s) => s.toLowerCase();

// env holds bare names (PORT, ALLOWED_ORIGINS, …) as produced by readServiceEnv() from the
// user-facing CROSSFERRY_* variables; error messages name the user-facing form
export function loadConfig(env = {}) {
  const get = (key) => env[key];

  const config = {
    // 0 = let the OS pick a free port (tests)
    PORT: parseNonNegativeInt(get("PORT"), 8080),
    HOST: get("HOST") || "0.0.0.0",

    // at least one of these must be present on a request; empty list disables the check
    REQUIRE_HEADERS: splitStr(get("REQUIRE_HEADERS") ?? "origin,x-requested-with").map(lower),
    // "https://app.example.com,https://*.example.com"; empty = any origin, answered with "*"
    ALLOWED_ORIGINS: splitStr(get("ALLOWED_ORIGINS")),
    BLOCKED_ORIGINS: splitStr(get("BLOCKED_ORIGINS")),
    // target hostnames, exact or "*.example.com"; empty = any host
    ALLOWED_HOSTS: splitStr(get("ALLOWED_HOSTS")).map(lower),
    // target ports; empty = any port
    ALLOWED_PORTS: parsePorts(get("ALLOWED_PORTS") ?? "80,443"),
    BLOCK_PRIVATE_IPS: parseBool(get("BLOCK_PRIVATE_IPS"), true),

    RATE_LIMIT: parseRateLimit(get("RATE_LIMIT"), get("RATE_LIMIT_EXEMPT")),

    MAX_REDIRECTS: parseNonNegativeInt(get("MAX_REDIRECTS"), 5),
    UPSTREAM_TIMEOUT_MS: parsePositiveInt(get("UPSTREAM_TIMEOUT_MS"), 30000),
    // preflight cache seconds; user-facing name is CROSSFERRY_CORS_MAX_AGE
    MAX_AGE: parseNonNegativeInt(get("MAX_AGE"), 600),

    // request headers dropped before forwarding (hop-by-hop ones are always dropped)
    REMOVE_HEADERS: splitStr(get("REMOVE_HEADERS") ?? "cookie,cookie2").map(lower),
    // "x-powered-by: CrossFerry; x-other: value"
    SET_HEADERS: parseSetHeaders(get("SET_HEADERS")),

    REDIRECT_SAME_ORIGIN: parseBool(get("REDIRECT_SAME_ORIGIN"), false),
    // public address used when rewriting Location headers; derived from the request when empty
    PUBLIC_BASE_URL: String(get("PUBLIC_BASE_URL") || "").replace(/\/+$/, ""),

    ENABLE_ACCESS_LOGS: parseBool(get("ENABLE_ACCESS_LOGS"), false),
    ENABLE_ERROR_LOGS: parseBool(get("ENABLE_ERROR_LOGS"), false),
  };

  return Object.freeze(config);
}

function parseNonNegativeInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const num = Number(value);
  return Number.isInteger(num) && num >= 0 ? num : fallback;
}

function parsePorts(value) {
  return splitStr(value).map((text) => {
    const port = Number(text);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`CROSSFERRY_ALLOWED_PORTS: invalid port "${text}"`);
    }
    return port;
  });
}

// cors-anywhere format: "<max> <minutes> [exempt hosts...]"; exemptions may also come from
// RATE_LIMIT_EXEMPT. An exemption is a literal host (case-insensitive) or a /regex/.
function parseRateLimit(spec, exemptSpec) {
  const tokens = splitStr(spec, /\s+/);
  if (!tokens.length) return null;

  const [maxText, minutesText, ...inlineExempt] = tokens;
  const max = Number(maxText);
  const minutes = Number(minutesText);
  if (!Number.isInteger(max) || max < 0 || !Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`CROSSFERRY_RATE_LIMIT: expected "<max requests> <period in minutes> [exempt hosts]", got "${spec}"`);
  }

  const exempt = [...inlineExempt, ...splitStr(exemptSpec, /\s+/)].map((entry) => {
    if (entry.startsWith("/") && entry.endsWith("/") && entry.length > 2) {
      try {
        return new RegExp(`^(?:${entry.slice(1, -1)})$`, "i");
      } catch (err) {
        throw new Error(`CROSSFERRY_RATE_LIMIT exemption ${entry} is not a valid regular expression: ${err.message}`);
      }
    }
    return entry.toLowerCase();
  });

  return { max, periodMs: minutes * 60_000, exempt };
}

function parseSetHeaders(spec) {
  return splitStr(spec, ";")
    .map((pair) => {
      const cut = pair.indexOf(":");
      if (cut === -1) throw new Error(`CROSSFERRY_SET_HEADERS: expected "name: value", got "${pair}"`);
      return [pair.slice(0, cut).trim().toLowerCase(), pair.slice(cut + 1).trim()];
    })
    .filter(([name]) => name);
}

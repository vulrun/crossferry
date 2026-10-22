const dns = require("node:dns");

// Prefer IPv4 when a hostname resolves to both families (process-wide; harmless to repeat)
dns.setDefaultResultOrder("ipv4first");

class ConfigError extends Error {
  constructor(errors) {
    super(errors.join("\n"));
    this.name = "ConfigError";
    this.errors = errors;
  }
}

// Reads bare-named settings (PORT, AUTH_USER, …) as produced by readServiceEnv() from the
// user-facing CROSSFERRY_* variables. Throws a ConfigError listing every problem.
function loadConfig(env = process.env) {
  const config = {
    PORT: env.PORT || 3128,
    HOST: env.HOST || "0.0.0.0",

    AUTH_USER: env.AUTH_USER || "",
    AUTH_PASS: env.AUTH_PASS || "",

    // e.g. "127.0.0.1,192.168.1.10"
    ALLOWED_IPS: splitStr(env.ALLOWED_IPS || ""),
    // e.g. "example.com,*.myapp.com" (hostnames are case-insensitive)
    ALLOWED_HOSTS: splitStr(env.ALLOWED_HOSTS || "").map((s) => s.toLowerCase()),

    // refuse to connect to loopback/private/link-local targets (SSRF guard), on unless "false"
    BLOCK_PRIVATE_IPS: env.BLOCK_PRIVATE_IPS != "false",
    // allow listening publicly with no auth and no IP allowlist
    ALLOW_OPEN_PROXY: env.ALLOW_OPEN_PROXY == "true",

    // enable logs
    ENABLE_ERROR_LOGS: env.ENABLE_ERROR_LOGS == "true",
    ENABLE_ACCESS_LOGS: env.ENABLE_ACCESS_LOGS == "true",

    TIMEOUT_MS: parsePositiveInt(env.TIMEOUT_MS, 60000),
  };

  config.REQUIRE_AUTH = Boolean(config.AUTH_USER && config.AUTH_PASS);

  const errors = validateConfig(config);
  if (errors.length) throw new ConfigError(errors);

  return Object.freeze(config);
}

module.exports = { loadConfig, ConfigError };

function splitStr(str, splitBy = ",") {
  return String(str || "")
    .split(splitBy)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePositiveInt(value, fallback) {
  const num = parseInt(value, 10);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

function validateConfig(cfg) {
  const errors = [];

  if (Boolean(cfg.AUTH_USER) !== Boolean(cfg.AUTH_PASS)) {
    errors.push("Set both CROSSFERRY_AUTH_USER and CROSSFERRY_AUTH_PASS, or neither");
  }

  const isLoopbackHost = ["127.0.0.1", "::1", "localhost"].includes(cfg.HOST);
  if (!cfg.REQUIRE_AUTH && !cfg.ALLOWED_IPS.length && !isLoopbackHost && !cfg.ALLOW_OPEN_PROXY) {
    errors.push(
      `Refusing to run an open proxy on ${cfg.HOST}: set CROSSFERRY_AUTH_USER/CROSSFERRY_AUTH_PASS or ` +
        `CROSSFERRY_ALLOWED_IPS (or CROSSFERRY_ALLOW_OPEN_PROXY=true if you really mean it)`
    );
  }

  return errors;
}

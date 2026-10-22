const dns = require("node:dns");
const net = require("node:net");
const http = require("node:http");
const crypto = require("node:crypto");

module.exports = {
  createLogger,
  parseURL,
  getClientIp,
  isAuthValid,
  isIpAllowed,
  isHostAllowed,
  isPrivateAddress,
  safeLookup,
  stripHopByHopHeaders,
  writeRes,
  sendSocketRes,
};

// logging: access lines to stdout, error lines to stderr, each gated by its config flag
function createLogger(config) {
  const timestamp = () => new Date().toISOString().split(".")[0].replace("T", " ");
  return {
    access(label, ...logs) {
      if (!config.ENABLE_ACCESS_LOGS) return;
      console.log(`[${timestamp()}]`, `[${String(label || "GENERIC_PROXY_LOGS").toUpperCase()}]`, ...logs);
    },
    error(label, ...logs) {
      if (!config.ENABLE_ERROR_LOGS) return;
      console.error(`[${timestamp()}]`, `[${String(label || "GENERIC_PROXY_ERROR").toUpperCase()}]`, ...logs);
    },
  };
}

// helper functions
function parseURL() {
  try {
    return new URL(...arguments);
  } catch (error) {
    return null;
  }
}

function getClientIp(req) {
  // Normalize IPv6-wrapped IPv4 like ::ffff:192.168.1.5
  return req.socket.remoteAddress?.replace("::ffff:", "") || "";
}

function isAuthValid(req, config) {
  if (!config.REQUIRE_AUTH) return true; // auth disabled

  const authHeader = req.headers["proxy-authorization"];
  if (!authHeader) return false;

  // scheme is case-insensitive (RFC 7617)
  const [scheme, authCreds] = authHeader.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "basic" || !authCreds) return false;

  // password may contain ":", so split on the first one only
  const decodedStr = Buffer.from(authCreds, "base64").toString("utf8");
  const sepIndex = decodedStr.indexOf(":");
  if (sepIndex === -1) return false;

  const user = decodedStr.slice(0, sepIndex);
  const pass = decodedStr.slice(sepIndex + 1);

  // evaluate both to keep timing independent of which one is wrong
  const userOk = safeEqual(user, config.AUTH_USER);
  const passOk = safeEqual(pass, config.AUTH_PASS);
  return userOk && passOk;
}

// constant-time string compare; hashing first avoids leaking length
function safeEqual(a, b) {
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function isIpAllowed(clientIp, allowedIps) {
  if (!allowedIps.length) return true; // Allow all if empty

  return allowedIps.includes(clientIp);
}

function isHostAllowed(targetHost, allowedHosts) {
  if (!allowedHosts.length) return true; // Allow all if empty

  // URL hostnames are already lowercased; "example.com." is the same host as "example.com"
  const host = String(targetHost || "").replace(/\.$/, "");

  for (const allowed of allowedHosts) {
    // allowlist contains hostnames (no ports);
    if (host === allowed) return true;
    // "*.example.com" allows subdomains of example.com (not example.com itself)
    if (allowed.startsWith("*.") && host.endsWith(allowed.slice(1))) return true;
  }
  return false;
}

// SSRF guard: loopback, private, link-local, CGNAT, multicast and reserved ranges.
// BlockList also matches IPv4-mapped IPv6 (::ffff:10.0.0.1) against the IPv4 rules.
const privateRanges = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  privateRanges.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  privateRanges.addSubnet(prefix, bits, "ipv6");
}

function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (!family) return false;
  return privateRanges.check(ip, family === 6 ? "ipv6" : "ipv4");
}

// drop-in for dns.lookup that refuses private addresses; the socket then connects to
// exactly the address checked here, so DNS rebinding can't swap it afterwards
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);

    const addresses = Array.isArray(address) ? address : [{ address, family }];
    const blocked = addresses.find((entry) => isPrivateAddress(entry.address));
    if (blocked) {
      const error = new Error(`Blocked private address ${blocked.address} for ${hostname}`);
      error.code = "EBLOCKED";
      return callback(error);
    }

    callback(null, address, family);
  });
}

// headers that apply to a single connection and must not be forwarded (RFC 9110 §7.6.1),
// plus proxy credentials which must never reach the target
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function stripHopByHopHeaders(headers) {
  const result = { ...headers };
  const connectionHeaders = String(headers.connection || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  for (const name of [...HOP_BY_HOP_HEADERS, ...connectionHeaders]) {
    delete result[name];
  }
  return result;
}

function sanitizeStatusCode(statusCode) {
  return http.STATUS_CODES[statusCode] ? statusCode : 500;
}

function sendSocketRes(socket, statusCode, message, headers) {
  try {
    if (!socket.destroyed && socket.writable) {
      const _statusCode = sanitizeStatusCode(statusCode);
      const _statusText = message || http.STATUS_CODES[_statusCode] || "Unknown Request";
      const finalHeaders = { Connection: "close", ...headers };

      const headerLines = Object.entries(finalHeaders).map(([k, v]) => `${k}: ${v}`);
      const response = `HTTP/1.1 ${_statusCode} ${_statusText}\r\n${headerLines.join(`\r\n`)}\r\n\r\n`;

      // destroy only after the response is flushed, so the client actually receives it
      socket.end(response, () => socket.destroy());
    } else {
      socket.destroy();
    }
  } catch (err) {
    // socket is in an unknown state, drop it
    try {
      socket.destroy();
    } catch (error) {} // socket might already closed
  }
}

function writeRes(res, statusCode, message, headers) {
  try {
    const _statusCode = sanitizeStatusCode(statusCode);
    const _statusText = message || http.STATUS_CODES[_statusCode] || "Unknown Proxy Request";
    const finalHeaders = { "Content-Type": "text/plain", ...headers };

    // Only write if headers not already sent
    if (!res.headersSent) {
      res.writeHead(_statusCode, finalHeaders);
    }

    return res.end(_statusText);
  } catch (err) {
    try {
      // If res is still open, force a fallback 500
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }

      res.end("Unexpected proxy error");
    } catch (_) {} // socket may already be closed
  }
}

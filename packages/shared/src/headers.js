// headers that describe one connection and must not be forwarded (RFC 9110 §7.6.1),
// plus proxy credentials which must never reach the target
export const HOP_BY_HOP_HEADERS = [
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

// Returns a new Headers without hop-by-hop headers, the names listed in `Connection`,
// and `remove` entries (exact names, or prefixes written as "cf-*").
export function stripHopByHop(headers, remove = []) {
  const source = headers instanceof Headers ? headers : new Headers(headers);
  const result = new Headers(source);

  const connectionTokens = (source.get("connection") || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  for (const name of [...HOP_BY_HOP_HEADERS, ...connectionTokens]) {
    result.delete(name);
  }

  const prefixes = [];
  for (const entry of remove) {
    const name = String(entry || "").toLowerCase();
    if (!name) continue;
    if (name.endsWith("*")) prefixes.push(name.slice(0, -1));
    else result.delete(name);
  }
  if (prefixes.length) {
    for (const name of headerNames(result)) {
      if (prefixes.some((prefix) => name.startsWith(prefix))) result.delete(name);
    }
  }

  return result;
}

// lowercase header names, deduplicated
export function headerNames(headers) {
  return [...new Set([...headers.keys()])];
}

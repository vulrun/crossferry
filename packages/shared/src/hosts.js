// lowercase, drop the trailing dot of a fully-qualified name
export function normalizeHost(host) {
  return String(host || "")
    .toLowerCase()
    .replace(/\.$/, "");
}

// allowlist entries are exact hostnames or "*.example.com" (subdomains only, not example.com itself)
export function isHostAllowed(targetHost, allowlist) {
  if (!allowlist || !allowlist.length) return true; // allow all if empty

  const host = normalizeHost(targetHost);
  for (const entry of allowlist) {
    const allowed = normalizeHost(entry);
    if (!allowed) continue;
    if (host === allowed) return true;
    if (allowed.startsWith("*.") && host.endsWith(allowed.slice(1))) return true;
  }
  return false;
}

// "localhost" and anything under it always resolve to loopback (RFC 6761)
export function isLocalHostname(host) {
  const name = normalizeHost(host).replace(/^\[|\]$/g, "");
  return name === "localhost" || name.endsWith(".localhost");
}

// origin patterns: "https://app.example.com", "https://*.example.com", or "*.example.com" (any scheme)
export function isOriginAllowed(origin, patterns) {
  if (!patterns || !patterns.length) return true;

  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const scheme = url.protocol;
  const host = url.host; // includes an explicit port, like the Origin header does

  for (const raw of patterns) {
    const pattern = String(raw || "").trim();
    if (!pattern) continue;

    const schemeCut = pattern.indexOf("://");
    const patternScheme = schemeCut === -1 ? null : pattern.slice(0, schemeCut + 1).toLowerCase();
    const patternHost = schemeCut === -1 ? pattern : pattern.slice(schemeCut + 3);

    if (patternScheme && patternScheme !== scheme) continue;
    if (isHostAllowed(host, [patternHost])) return true;
  }
  return false;
}

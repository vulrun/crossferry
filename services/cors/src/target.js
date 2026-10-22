// The target is the request path minus its leading slash, plus the query string, exactly like
// cors-anywhere: /https://api.example.com/v1?x=1 → https://api.example.com/v1?x=1

const ROUTES = {
  "/": "help",
  "": "help",
  "/iscorsneeded": "iscorsneeded",
  "/healthz": "healthz",
  "/favicon.ico": "favicon",
};

export function parseTarget(pathname, search = "") {
  if (pathname in ROUTES) return { route: ROUTES[pathname] };

  let text = pathname.slice(1) + search;

  // some platforms collapse "//" in paths: "https:/host" → "https://host"
  text = text.replace(/^(https?):\/(?!\/)/i, "$1://");

  // "ftp://…", "file://…": anything with a scheme that is not http(s)
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1];
  if (scheme && !/^https?$/i.test(scheme)) {
    return { error: "Bad Request: only http and https targets are supported" };
  }

  if (/^https?:\/\//i.test(text)) {
    text = text.replace(/^https?/i, (scheme) => scheme.toLowerCase());
  } else {
    // scheme omitted: "//host/path" or "host/path"; port 443 implies https, anything else http
    if (text.startsWith("//")) text = text.slice(2);
    const authority = /^[^/?#]*/.exec(text)[0];
    text = (/:443$/.test(authority) ? "https://" : "http://") + text;
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: "Bad Request: expected /https://host/path" };
  }

  if (!url.hostname) return { error: "Bad Request: expected /https://host/path" };
  if (url.username || url.password) return { error: "Bad Request: credentials in the target URL are not allowed" };

  return { url, port: targetPort(url) };
}

export function targetPort(url) {
  return Number(url.port) || (url.protocol === "https:" ? 443 : 80);
}

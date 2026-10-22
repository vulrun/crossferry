import { stripHopByHop, headerNames } from "@crossferry/shared";
import { PolicyError } from "./policy.js";

// headers that identify the client or the platform; the target only ever sees this service
const PLATFORM_HEADERS = [
  "host",
  "forwarded",
  "x-real-ip",
  "via",
  "x-cloud-trace-context",
  "cf-*",
  "x-forwarded-*",
  "x-amzn-*",
  "x-appengine-*",
  // the runtime's fetch negotiates its own encoding and decodes transparently (see shapeResponse)
  "accept-encoding",
];

const FOLLOW_STATUSES = new Set([301, 302, 303]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function buildRequestHeaders(incoming, config) {
  const headers = stripHopByHop(incoming, [...PLATFORM_HEADERS, ...config.REMOVE_HEADERS]);
  for (const [name, value] of config.SET_HEADERS) headers.set(name, value);
  return headers;
}

// Fetches the target, following 301/302/303 like a browser would (as GET, without the body),
// and returns the final upstream response with CORS and tracing headers applied.
export async function forward(request, target, config, { fetchImpl, cors, publicBase, recheck }) {
  let url = target.url;
  let method = request.method;
  let headers = buildRequestHeaders(request.headers, config);
  let body = method === "GET" || method === "HEAD" ? undefined : request.body;

  const trace = new Headers({ "x-request-url": url.href });

  for (let hop = 0; ; hop++) {
    const upstream = await fetchWithHeaderTimeout(fetchImpl, url.href, { method, headers, body }, config.UPSTREAM_TIMEOUT_MS);

    const location = upstream.headers.get("location");
    if (!location || !REDIRECT_STATUSES.has(upstream.status)) {
      return shapeResponse(upstream, url, trace, cors, null);
    }

    let next = null;
    try {
      next = new URL(location, url);
    } catch {
      // unparseable Location: pass the response through untouched
    }

    if (next && FOLLOW_STATUSES.has(upstream.status) && hop < config.MAX_REDIRECTS) {
      const problem = recheck(next);
      if (problem) {
        await discard(upstream);
        throw problem;
      }
      trace.set(`x-cors-redirect-${hop + 1}`, `${upstream.status} ${next.href}`);
      await discard(upstream);

      url = next;
      method = "GET";
      body = undefined;
      headers = new Headers(headers);
      headers.delete("content-type");
      headers.delete("content-length");
      continue;
    }

    // 307/308, or too many hops: let the client follow, but through this service
    const rewritten = next ? `${publicBase}/${next.href}` : null;
    return shapeResponse(upstream, url, trace, cors, rewritten);
  }
}

// The timeout guards the wait for response headers only; a slow but flowing body is never cut.
async function fetchWithHeaderTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Upstream timed out", "TimeoutError")), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
      ...(init.body ? { duplex: "half" } : {}),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function discard(response) {
  try {
    await response.body?.cancel();
  } catch {
    // already consumed or closed
  }
}

function shapeResponse(upstream, finalUrl, trace, cors, locationOverride) {
  // never relay cookies; drop the target's own CORS decisions so ours are the only ones
  const headers = stripHopByHop(upstream.headers, ["set-cookie", "set-cookie2", "access-control-*"]);

  // the runtime already decoded the body, so the encoding headers no longer describe it
  if (headers.has("content-encoding")) {
    headers.delete("content-encoding");
    headers.delete("content-length");
  }

  if (locationOverride) headers.set("location", locationOverride);
  for (const [name, value] of trace) headers.set(name, value);
  headers.set("x-final-url", finalUrl.href);

  for (const [name, value] of cors) {
    if (name === "vary") headers.append("vary", value);
    else headers.set(name, value);
  }

  headers.set("access-control-expose-headers", headerNames(headers).join(","));

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

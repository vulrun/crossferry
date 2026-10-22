// served at "/"; a module rather than a file so it works on runtimes without a filesystem
export const HELP_TEXT = `CrossFerry CORS proxy

Prefix the URL you want to reach with this service's address:

  https://<this host>/https://api.example.com/v1/items?limit=10
  https://<this host>/example.com/page          (no scheme: http, or https when the port is 443)

Requirements
  - Send an Origin or X-Requested-With header. Browsers add Origin automatically.
  - Targets must be http(s) on an allowed port (80 and 443 by default).
  - Private, loopback and link-local addresses are refused.

What you get back
  - The target's status, headers and body, plus Access-Control-Allow-Origin.
  - Access-Control-Expose-Headers lists every header so scripts can read them all.
  - Cookies are removed in both directions.
  - 301/302/303 redirects are followed (up to 5 hops); 307/308 are returned with
    Location rewritten to go through this service again.
  - X-Request-URL, X-Final-URL and X-CORS-Redirect-N describe what happened.

Endpoints
  /              this text
  /healthz       "ok"
  /iscorsneeded  "no"

CrossFerry CORS proxy, modelled on cors-anywhere (https://github.com/Rob--W/cors-anywhere).
`;

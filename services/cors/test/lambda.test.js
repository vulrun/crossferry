import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// the adapter reads its config when imported, so relax the local-upstream rules first
process.env.CROSSFERRY_BLOCK_PRIVATE_IPS = "false";
process.env.CROSSFERRY_ALLOWED_PORTS = "";
const { bufferedHandler } = await import("../src/adapters/lambda.js");

let upstreamPort;
let upstream;

test.before(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url.startsWith("/binary")) {
      res.setHeader("content-type", "application/octet-stream");
      res.end(Buffer.from([0, 1, 2, 255]));
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.setHeader("set-cookie", "s=1");
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = upstream.address().port;
});

test.after(() => upstream.close());

// Lambda Function URL / HTTP API v2 payload
function event({ method = "GET", path, query = "", headers = {}, body, isBase64Encoded = false }) {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: query,
    headers: { host: "abc123.lambda-url.us-east-1.on.aws", "x-forwarded-proto": "https", ...headers },
    requestContext: {
      accountId: "123456789012",
      apiId: "abc123",
      domainName: "abc123.lambda-url.us-east-1.on.aws",
      domainPrefix: "abc123",
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "203.0.113.7", userAgent: "test" },
      requestId: "req-1",
      routeKey: "$default",
      stage: "$default",
      time: "21/Oct/2026:06:00:00 +0000",
      timeEpoch: 1792396800000,
    },
    body,
    isBase64Encoded,
  };
}

const context = { awsRequestId: "req-1", functionName: "crossferry-cors", getRemainingTimeInMillis: () => 60000 };

test("preflight through the Lambda adapter", async () => {
  const out = await bufferedHandler(
    event({ method: "OPTIONS", path: `/http://127.0.0.1:${upstreamPort}/items`, headers: { origin: "https://app.test", "access-control-request-method": "DELETE" } }),
    context
  );
  assert.equal(out.statusCode, 200);
  assert.equal(out.headers["access-control-allow-origin"], "*");
  assert.equal(out.headers["access-control-allow-methods"], "DELETE");
});

test("GET and POST are proxied with the right URL, headers and body", async () => {
  const get = await bufferedHandler(
    event({ path: `/http://127.0.0.1:${upstreamPort}/items`, query: "page=2", headers: { origin: "https://app.test", cookie: "a=b" } }),
    context
  );
  assert.equal(get.statusCode, 200);
  assert.equal(get.headers["access-control-allow-origin"], "*");
  assert.equal(get.headers["x-request-url"], `http://127.0.0.1:${upstreamPort}/items?page=2`);
  assert.equal(get.headers["set-cookie"], undefined);
  assert.equal(get.cookies, undefined);
  const echoed = JSON.parse(get.body);
  assert.equal(echoed.url, "/items?page=2");
  assert.equal(echoed.headers.cookie, undefined);

  const post = await bufferedHandler(
    event({ method: "POST", path: `/http://127.0.0.1:${upstreamPort}/upload`, headers: { origin: "https://app.test", "content-type": "text/plain" }, body: "lambda body" }),
    context
  );
  assert.equal(post.statusCode, 200);
  assert.equal(JSON.parse(post.body).body, "lambda body");
});

test("binary responses are base64-encoded for the Lambda payload", async () => {
  const out = await bufferedHandler(event({ path: `/http://127.0.0.1:${upstreamPort}/binary`, headers: { origin: "https://app.test" } }), context);
  assert.equal(out.statusCode, 200);
  assert.equal(out.isBase64Encoded, true);
  assert.deepEqual([...Buffer.from(out.body, "base64")], [0, 1, 2, 255]);
});

test("rejections carry CORS headers through the adapter", async () => {
  const out = await bufferedHandler(event({ path: `/http://127.0.0.1:${upstreamPort}/` }), context);
  assert.equal(out.statusCode, 400);
  assert.equal(out.headers["access-control-allow-origin"], "*");
  assert.match(out.body, /Missing required request header/);
});

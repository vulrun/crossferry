import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Writable } from "node:stream";

process.env.CROSSFERRY_BLOCK_PRIVATE_IPS = "false";
process.env.CROSSFERRY_ALLOWED_PORTS = "";
const { cors } = await import("../src/adapters/gcf.js");

let upstreamPort;
let upstream;

test.before(async () => {
  upstream = http.createServer((req, res) => {
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

// what the Functions Framework (Express) hands us: parsed body, raw bytes on rawBody, get() for headers
function fakeRequest({ method = "GET", url, headers = {}, rawBody }) {
  const all = { host: "cors-abc-uc.a.run.app", "x-forwarded-proto": "https", ...headers };
  return {
    method,
    url,
    originalUrl: url,
    protocol: "http",
    headers: all,
    rawBody,
    body: rawBody ? rawBody.toString() : undefined,
    get: (name) => all[name.toLowerCase()],
  };
}

function fakeResponse() {
  const chunks = [];
  const res = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.statusCode = 200;
  res.headers = {};
  res.status = (code) => ((res.statusCode = code), res);
  res.setHeader = (name, value) => (res.headers[name] = value);
  res.done = new Promise((resolve) => res.on("finish", resolve));
  res.text = async () => {
    await res.done;
    return Buffer.concat(chunks).toString();
  };
  return res;
}

test("GET through the Cloud Functions adapter", async () => {
  const req = fakeRequest({ url: `/http://127.0.0.1:${upstreamPort}/items?x=1`, headers: { origin: "https://app.test", cookie: "a=b" } });
  const res = fakeResponse();
  await cors(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], "*");
  assert.equal(res.headers["x-request-url"], `http://127.0.0.1:${upstreamPort}/items?x=1`);
  assert.equal(res.headers["set-cookie"], undefined);
  const echoed = JSON.parse(await res.text());
  assert.equal(echoed.url, "/items?x=1");
  assert.equal(echoed.headers.cookie, undefined);
});

test("POST body is rebuilt from rawBody, which the framework already consumed", async () => {
  const req = fakeRequest({
    method: "POST",
    url: `/http://127.0.0.1:${upstreamPort}/upload`,
    headers: { origin: "https://app.test", "content-type": "application/json" },
    rawBody: Buffer.from('{"hello":"gcf"}'),
  });
  const res = fakeResponse();
  await cors(req, res);
  assert.equal(res.statusCode, 200);
  const echoed = JSON.parse(await res.text());
  assert.equal(echoed.method, "POST");
  assert.equal(echoed.body, '{"hello":"gcf"}');
});

test("preflight and rejections work without a body", async () => {
  const pre = fakeResponse();
  await cors(fakeRequest({ method: "OPTIONS", url: "/http://x.test/", headers: { origin: "https://app.test", "access-control-request-method": "PUT" } }), pre);
  assert.equal(pre.statusCode, 200);
  assert.equal(pre.headers["access-control-allow-methods"], "PUT");
  assert.equal(await pre.text(), "");

  const rejected = fakeResponse();
  await cors(fakeRequest({ url: `/http://127.0.0.1:${upstreamPort}/` }), rejected);
  assert.equal(rejected.statusCode, 400);
  assert.match(await rejected.text(), /Missing required request header/);
});

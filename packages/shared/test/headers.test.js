import test from "node:test";
import assert from "node:assert/strict";
import { stripHopByHop, headerNames, HOP_BY_HOP_HEADERS } from "../src/headers.js";

test("stripHopByHop removes the RFC set, proxy credentials and Connection-listed names", () => {
  const input = new Headers({
    "Content-Type": "text/plain",
    Connection: "keep-alive, X-Private",
    "Keep-Alive": "timeout=5",
    "Proxy-Authorization": "Basic abc",
    "Proxy-Connection": "keep-alive",
    TE: "trailers",
    Trailer: "x",
    "Transfer-Encoding": "chunked",
    Upgrade: "websocket",
    "X-Private": "drop",
    "X-Custom": "keep",
  });
  const out = stripHopByHop(input);
  for (const name of HOP_BY_HOP_HEADERS) assert.equal(out.has(name), false, name);
  assert.equal(out.has("x-private"), false);
  assert.equal(out.get("x-custom"), "keep");
  assert.equal(out.get("content-type"), "text/plain");
  // input is untouched
  assert.equal(input.get("connection"), "keep-alive, X-Private");
});

test("stripHopByHop honours extra names and prefix wildcards", () => {
  const input = new Headers({
    Cookie: "a=b",
    "CF-Connecting-IP": "1.2.3.4",
    "cf-ray": "x",
    "X-Forwarded-For": "1.2.3.4",
    Accept: "*/*",
  });
  const out = stripHopByHop(input, ["cookie", "cf-*", "X-Forwarded-*"]);
  assert.deepEqual(headerNames(out), ["accept"]);
});

test("stripHopByHop accepts plain objects and keeps multiple set-cookie values", () => {
  const out = stripHopByHop({ "set-cookie": "a=1", accept: "x" });
  assert.equal(out.get("set-cookie"), "a=1");

  const multi = new Headers();
  multi.append("set-cookie", "a=1");
  multi.append("set-cookie", "b=2");
  assert.deepEqual(stripHopByHop(multi).getSetCookie(), ["a=1", "b=2"]);
});

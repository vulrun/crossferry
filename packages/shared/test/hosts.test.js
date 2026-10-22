import test from "node:test";
import assert from "node:assert/strict";
import { normalizeHost, isHostAllowed, isLocalHostname, isOriginAllowed } from "../src/hosts.js";

test("normalizeHost lowercases and strips the trailing dot", () => {
  assert.equal(normalizeHost("Example.COM."), "example.com");
  assert.equal(normalizeHost(""), "");
  assert.equal(normalizeHost(undefined), "");
});

test("isHostAllowed: empty list allows everything", () => {
  assert.equal(isHostAllowed("anything.test", []), true);
  assert.equal(isHostAllowed("anything.test", undefined), true);
});

test("isHostAllowed: exact and wildcard entries", () => {
  const list = ["exact.test", "*.wild.test", "MIXED.Case"];
  assert.equal(isHostAllowed("exact.test", list), true);
  assert.equal(isHostAllowed("EXACT.TEST.", list), true);
  assert.equal(isHostAllowed("sub.exact.test", list), false);
  assert.equal(isHostAllowed("a.wild.test", list), true);
  assert.equal(isHostAllowed("a.b.wild.test", list), true);
  assert.equal(isHostAllowed("wild.test", list), false);
  assert.equal(isHostAllowed("evilwild.test", list), false);
  assert.equal(isHostAllowed("mixed.case", list), true);
});

test("isLocalHostname", () => {
  assert.equal(isLocalHostname("localhost"), true);
  assert.equal(isLocalHostname("LOCALHOST."), true);
  assert.equal(isLocalHostname("foo.localhost"), true);
  assert.equal(isLocalHostname("localhost.test"), false);
  assert.equal(isLocalHostname("example.com"), false);
});

test("isOriginAllowed: empty list allows everything, bad origins never match a list", () => {
  assert.equal(isOriginAllowed("https://a.test", []), true);
  assert.equal(isOriginAllowed("not a url", ["https://a.test"]), false);
  assert.equal(isOriginAllowed("null", ["https://a.test"]), false);
});

test("isOriginAllowed: scheme-qualified and scheme-less patterns, wildcards, ports", () => {
  const list = ["https://app.test", "https://*.wild.test", "*.any.test", "http://localhost:3000"];
  assert.equal(isOriginAllowed("https://app.test", list), true);
  assert.equal(isOriginAllowed("http://app.test", list), false);
  assert.equal(isOriginAllowed("https://x.wild.test", list), true);
  assert.equal(isOriginAllowed("http://x.wild.test", list), false);
  assert.equal(isOriginAllowed("https://wild.test", list), false);
  assert.equal(isOriginAllowed("http://a.any.test", list), true);
  assert.equal(isOriginAllowed("https://b.any.test", list), true);
  assert.equal(isOriginAllowed("http://localhost:3000", list), true);
  assert.equal(isOriginAllowed("http://localhost:3001", list), false);
  assert.equal(isOriginAllowed("https://APP.TEST", list), true);
});

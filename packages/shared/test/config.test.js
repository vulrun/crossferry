import test from "node:test";
import assert from "node:assert/strict";
import { splitStr, parsePositiveInt, parseBool } from "../src/config.js";
import { timestamp, createLogger } from "../src/log.js";

test("splitStr trims and drops empties", () => {
  assert.deepEqual(splitStr(" a, b ,,c "), ["a", "b", "c"]);
  assert.deepEqual(splitStr(""), []);
  assert.deepEqual(splitStr(undefined), []);
  assert.deepEqual(splitStr("a b  c", " "), ["a", "b", "c"]);
});

test("parsePositiveInt falls back on junk, zero and negatives", () => {
  assert.equal(parsePositiveInt("30", 5), 30);
  assert.equal(parsePositiveInt("abc", 5), 5);
  assert.equal(parsePositiveInt("0", 5), 5);
  assert.equal(parsePositiveInt("-3", 5), 5);
  assert.equal(parsePositiveInt(undefined, 5), 5);
});

test("parseBool only reacts to true/false", () => {
  assert.equal(parseBool("true", false), true);
  assert.equal(parseBool("FALSE", true), false);
  assert.equal(parseBool("yes", false), false);
  assert.equal(parseBool("", true), true);
  assert.equal(parseBool(undefined, false), false);
});

test("timestamp format and logger gating", () => {
  assert.match(timestamp(new Date("2026-10-21T06:11:35.123Z")), /^\[2026-10-21 06:11:35\]$/);

  const lines = { log: [], error: [] };
  const out = { log: (...a) => lines.log.push(a), error: (...a) => lines.error.push(a) };

  const quiet = createLogger({ out });
  quiet.access("http", "x");
  quiet.error("boom", "y");
  assert.deepEqual(lines, { log: [], error: [] });

  const loud = createLogger({ access: true, errors: true, out });
  loud.access("http", "GET", "/");
  loud.error("upstream", "fail");
  assert.equal(lines.log.length, 1);
  assert.equal(lines.log[0][1], "[HTTP]");
  assert.equal(lines.error.length, 1);
  assert.equal(lines.error[0][1], "[UPSTREAM]");
});

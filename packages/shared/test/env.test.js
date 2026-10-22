import test from "node:test";
import assert from "node:assert/strict";
import { readServiceEnv, serviceEnabled, ENV_PREFIX } from "../src/env.js";

const env = {
  CROSSFERRY_HOST: "127.0.0.1",
  CROSSFERRY_PORT: "3128",
  CROSSFERRY_CORS_PORT: "8080",
  CROSSFERRY_ENABLE_ACCESS_LOGS: "false",
  CROSSFERRY_FORWARD_ENABLE_ACCESS_LOGS: "true",
  CROSSFERRY_ALLOWED_ORIGINS: "https://a.test",
  CROSSFERRY_CORS_MAX_AGE: "60",
  CROSSFERRY_FORWARD_ENABLED: "false",
  PORT: "1",
  HOST: "evil",
  OTHER: "x",
};

test("prefix constant", () => {
  assert.equal(ENV_PREFIX, "CROSSFERRY_");
});

test("forward proxy: shared values, its own infixed overrides, CROSSFERRY_PORT; nothing foreign or unprefixed", () => {
  const forward = readServiceEnv(env, "forward");
  assert.deepEqual(forward, {
    HOST: "127.0.0.1",
    PORT: "3128",
    ENABLE_ACCESS_LOGS: "true",
    ALLOWED_ORIGINS: "https://a.test",
    ENABLED: "false",
  });
});

test("CORS proxy: shared values, CROSSFERRY_CORS_* with the infix stripped, never CROSSFERRY_PORT", () => {
  const cors = readServiceEnv(env, "cors");
  assert.deepEqual(cors, {
    HOST: "127.0.0.1",
    PORT: "8080",
    ENABLE_ACCESS_LOGS: "false",
    ALLOWED_ORIGINS: "https://a.test",
    MAX_AGE: "60",
  });
});

test("infixed value wins over the shared one; undefined values are skipped", () => {
  const out = readServiceEnv({ CROSSFERRY_HOST: "a", CROSSFERRY_CORS_HOST: "b", CROSSFERRY_TIMEOUT_MS: undefined }, "cors");
  assert.deepEqual(out, { HOST: "b" });
  assert.deepEqual(readServiceEnv(undefined, "forward"), {});
});

test("serviceEnabled and unknown services", () => {
  assert.equal(serviceEnabled(env, "forward"), false);
  assert.equal(serviceEnabled(env, "cors"), true);
  assert.equal(serviceEnabled({}, "cors"), true);
  assert.throws(() => readServiceEnv(env, "proxy"), /unknown service/);
  assert.throws(() => serviceEnabled(env, "nope"), /unknown service/);
});

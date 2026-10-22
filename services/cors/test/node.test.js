import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fetch as undiciFetch, Agent } from "undici";
import { createSafeLookup } from "../src/adapters/lookup.js";

const ADAPTER = path.join(import.meta.dirname, "..", "src", "adapters", "node.js");

let echoPort;
const servers = [];

test.before(async () => {
  echoPort = await listen(
    http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.setHeader("set-cookie", "session=1");
        res.setHeader("x-upstream", "echo");
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
      });
    })
  );
});

test.after(() => {
  for (const server of servers) server.close();
});

test("end to end: preflight, GET, POST body, header hygiene", async (t) => {
  const cors = await startCors(t);
  const base = `http://127.0.0.1:${cors.port}`;
  const target = `http://127.0.0.1:${echoPort}`;

  const preflight = await fetch(`${base}/${target}/items`, {
    method: "OPTIONS",
    headers: { origin: "https://app.test", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
  });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.equal(preflight.headers.get("access-control-allow-headers"), "content-type");

  const get = await fetch(`${base}/${target}/items?x=1`, { headers: { origin: "https://app.test", cookie: "a=b", "x-custom": "keep" } });
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("access-control-allow-origin"), "*");
  assert.equal(get.headers.get("x-request-url"), `${target}/items?x=1`);
  assert.equal(get.headers.get("x-upstream"), "echo");
  assert.equal(get.headers.has("set-cookie"), false);
  const echoed = await get.json();
  assert.equal(echoed.url, "/items?x=1");
  assert.equal(echoed.headers.cookie, undefined);
  assert.equal(echoed.headers["x-custom"], "keep");
  assert.equal(echoed.headers.host, `127.0.0.1:${echoPort}`);

  const post = await fetch(`${base}/${target}/upload`, {
    method: "POST",
    headers: { origin: "https://app.test", "content-type": "text/plain" },
    body: "hello from the client",
  });
  assert.equal(post.status, 200);
  assert.equal((await post.json()).body, "hello from the client");
});

test("missing Origin is refused, help text served at /", async (t) => {
  const cors = await startCors(t);
  const base = `http://127.0.0.1:${cors.port}`;
  assert.equal((await fetch(`${base}/http://127.0.0.1:${echoPort}/`)).status, 400);
  const help = await fetch(`${base}/`);
  assert.equal(help.status, 200);
  assert.match(await help.text(), /CORS proxy/);
});

test("with the guard on, localhost and loopback targets are refused", async (t) => {
  const cors = await startCors(t, { CROSSFERRY_BLOCK_PRIVATE_IPS: "true", CROSSFERRY_ALLOWED_PORTS: "" });
  const base = `http://127.0.0.1:${cors.port}`;
  for (const target of [`http://localhost:${echoPort}/`, `http://127.0.0.1:${echoPort}/`]) {
    const res = await fetch(`${base}/${target}`, { headers: { origin: "https://app.test" } });
    assert.equal(res.status, 403, target);
  }
});

test("safeLookup refuses private DNS results and passes public ones through", async () => {
  const resolveTo = (addresses) => (host, opts, cb) => cb(null, addresses, undefined);
  const lookupPrivate = createSafeLookup(resolveTo([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.9", family: 4 }]));
  const lookupPublic = createSafeLookup(resolveTo([{ address: "93.184.216.34", family: 4 }]));
  const lookupSingle = createSafeLookup((host, opts, cb) => cb(null, "127.0.0.1", 4));

  const call = (lookup) => new Promise((resolve) => lookup("example.test", { all: true }, (err, addr) => resolve({ err, addr })));

  const blocked = await call(lookupPrivate);
  assert.equal(blocked.err.code, "EBLOCKED");
  const ok = await call(lookupPublic);
  assert.equal(ok.err, null);
  assert.equal(ok.addr[0].address, "93.184.216.34");
  const single = await call(lookupSingle);
  assert.equal(single.err.code, "EBLOCKED");
});

test("undici honours the connect-time lookup hook, so DNS pinning really applies", async () => {
  // resolve a name that cannot exist to the local echo server; if the hook were ignored, this would fail with ENOTFOUND.
  // Node asks the lookup for { all: true } (happy eyeballs) and expects an array in that case, like dns.lookup gives.
  const loopback = (host, opts, cb) => cb(null, opts.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4);
  const dispatcher = new Agent({ connect: { lookup: loopback } });
  const res = await undiciFetch(`http://pinned.invalid:${echoPort}/via-hook`, { dispatcher });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, "/via-hook");

  const blocking = new Agent({ connect: { lookup: createSafeLookup(loopback) } });
  await assert.rejects(undiciFetch(`http://pinned.invalid:${echoPort}/`, { dispatcher: blocking }), (err) => err.cause?.code === "EBLOCKED");
});

test("SIGTERM shuts the adapter down cleanly", async (t) => {
  const cors = await startCors(t);
  const exited = new Promise((resolve) => cors.child.once("exit", resolve));
  cors.child.kill("SIGTERM");
  const code = await Promise.race([exited, delay(5000).then(() => "timeout")]);
  assert.equal(code, 0);
});

// helpers

function listen(server) {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function startCors(t, env = {}) {
  const child = spawn(process.execPath, [ADAPTER], {
    // local upstreams live on 127.0.0.1 with random ports, so the guard and the port list are relaxed by default
    env: {
      PATH: process.env.PATH,
      CROSSFERRY_HOST: "127.0.0.1",
      CROSSFERRY_CORS_PORT: "0",
      CROSSFERRY_BLOCK_PRIVATE_IPS: "false",
      CROSSFERRY_ALLOWED_PORTS: "",
      CROSSFERRY_ENABLE_ERROR_LOGS: "true",
      ...env,
    },
  });
  t.after(() => child.kill());

  let output = "";
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /listening on .*:(\d+)/.exec(output);
      if (match) resolve({ port: Number(match[1]), child });
    });
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("exit", (code) => reject(new Error(`adapter exited with code ${code}:\n${output}`)));
  });
}

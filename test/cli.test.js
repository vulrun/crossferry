import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const CLI = path.join(import.meta.dirname, "..", "bin", "crossferry.js");

let echo;
let echoPort;

test.before(async () => {
  echo = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: req.url, headers: req.headers }));
  });
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  echoPort = echo.address().port;
});

test.after(() => echo.close());

test("`crossferry` with no command runs both services and routes traffic to each", async (t) => {
  const run = await startCli(t, [], { CROSSFERRY_FORWARD_ENABLE_ACCESS_LOGS: "true" });

  // forward proxy: an absolute-URL request through it
  const viaForward = await rawHttp(run.ports.forward, `GET http://127.0.0.1:${echoPort}/p HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\nConnection: close\r\n\r\n`);
  assert.match(viaForward, /^HTTP\/1\.1 200/);
  assert.match(viaForward, /"url":"\/p"/);

  // CORS proxy: cors-anywhere style path
  const viaCors = await fetch(`http://127.0.0.1:${run.ports.cors}/http://127.0.0.1:${echoPort}/c`, { headers: { origin: "https://app.test" } });
  assert.equal(viaCors.status, 200);
  assert.equal(viaCors.headers.get("access-control-allow-origin"), "*");
  assert.equal((await viaCors.json()).url, "/c");

  await delay(100);
  const output = run.output();
  assert.match(output, /🧩 CrossFerry running: forward on :\d+, cors on :\d+/);
  // the FORWARD_ infix reached the forward proxy only
  assert.match(output, /\[HTTP\] GET http:\/\/127\.0\.0\.1/);
  assert.doesNotMatch(output, /\[CORS\]/);
});

test("`crossferry forward` and `crossferry cors` run exactly one service", async (t) => {
  const forward = await startCli(t, ["forward"], {}, { forward: true, cors: false });
  assert.ok(forward.ports.forward > 0);
  assert.equal(forward.ports.cors, undefined);
  assert.match(forward.output(), /🧩 CrossFerry running: forward on :\d+$/m);
  assert.doesNotMatch(forward.output(), /CORS proxy listening/);

  const cors = await startCli(t, ["cors"], {}, { forward: false, cors: true });
  assert.ok(cors.ports.cors > 0);
  assert.equal(cors.ports.forward, undefined);
  assert.match(cors.output(), /🧩 CrossFerry running: cors on :\d+$/m);
  assert.doesNotMatch(cors.output(), /forward proxy listening/);
});

test("CROSSFERRY_CORS_ENABLED=false switches a service off under `all`", async (t) => {
  const run = await startCli(t, ["all"], { CROSSFERRY_CORS_ENABLED: "false" }, { forward: true, cors: false });
  assert.match(run.output(), /cors disabled \(CROSSFERRY_CORS_ENABLED=false\)/);
  assert.ok(run.ports.forward > 0);
  assert.equal(run.ports.cors, undefined);
});

test("--help and --version exit 0; an unknown command exits 2 with usage", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^CrossFerry — a forward HTTP\/HTTPS proxy and CORS proxy/);
  assert.match(help.stdout, /Usage: crossferry \[command\]/);
  for (const command of ["all", "forward", "cors"]) assert.match(help.stdout, new RegExp(`^  ${command}\\s+run `, "m"));

  const version = await runCli(["--version"]);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^crossferry \d+\.\d+\.\d+/);

  const bad = await runCli(["sideways"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /Usage: crossferry \[command\]/);
});

test("a configuration error in either service stops the whole process with exit code 1", async (t) => {
  const badForward = await startCli(t, [], { CROSSFERRY_AUTH_USER: "alice" }).then(() => assert.fail("expected exit"), (e) => e);
  assert.equal(badForward.code, 1);
  assert.match(badForward.output, /⛔ \[forward\] Set both CROSSFERRY_AUTH_USER and CROSSFERRY_AUTH_PASS/);

  const badCors = await startCli(t, [], { CROSSFERRY_RATE_LIMIT: "lots" }).then(() => assert.fail("expected exit"), (e) => e);
  assert.equal(badCors.code, 1);
  assert.match(badCors.output, /⛔ \[cors\] CROSSFERRY_RATE_LIMIT/);
});

test("SIGTERM stops both services and exits 0", async (t) => {
  const run = await startCli(t, []);
  const exited = new Promise((resolve) => run.child.once("exit", (code, signal) => resolve({ code, signal })));
  run.child.kill("SIGTERM");
  const result = await Promise.race([exited, delay(5000).then(() => "timeout")]);
  assert.deepEqual(result, { code: 0, signal: null });
  assert.match(run.output(), /🛑 SIGTERM received/);
});

// helpers

const BASE_ENV = {
  CROSSFERRY_HOST: "127.0.0.1",
  CROSSFERRY_PORT: "0",
  CROSSFERRY_CORS_PORT: "0",
  CROSSFERRY_BLOCK_PRIVATE_IPS: "false",
  CROSSFERRY_ALLOWED_PORTS: "",
  CROSSFERRY_ENABLE_ERROR_LOGS: "true",
};

// spawns the CLI with a clean env and random ports; resolves once the "running" line appears
function startCli(t, args = [], env = {}, expect = { forward: true, cors: true }) {
  const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...BASE_ENV, ...env } });
  t.after(() => child.kill());

  let output = "";
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!/🧩 CrossFerry running/.test(output)) return;
      const forward = /forward proxy listening on .*:(\d+)/.exec(output)?.[1];
      const cors = /CORS proxy listening on .*:(\d+)/.exec(output)?.[1];
      if ((expect.forward && !forward) || (expect.cors && !cors)) return;
      resolve({ child, ports: { forward: forward && Number(forward), cors: cors && Number(cors) }, output: () => output });
    });
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("exit", (code) => reject(Object.assign(new Error(`crossferry exited with code ${code}:\n${output}`), { code, output })));
  });
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function rawHttp(port, text) {
  return new Promise((resolve, reject) => {
    let data = "";
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (data += chunk));
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
  });
}

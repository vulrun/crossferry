const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const ENTRY = path.join(__dirname, "..", "index.js");
const basic = (user, pass) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

// local upstreams the proxy forwards to
const servers = [];
const sockets = new Set();
let echoPort, hangPort, brokenPort;

test.before(async () => {
  // replies with what it received
  echoPort = await listen(
    http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
      });
    })
  );
  // accepts and never replies
  hangPort = await listen(net.createServer(() => {}));
  // sends headers and part of the body, then drops the connection
  brokenPort = await listen(
    net.createServer((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial");
        setTimeout(() => socket.destroy(), 50);
      });
    })
  );
});

test.after(() => {
  for (const socket of sockets) socket.destroy();
  for (const server of servers) server.close();
});

test("origin-form request (GET /) gets 400 and does not crash", async (t) => {
  const proxy = await startProxy(t);
  const res = await proxyRequest(proxy.port, "/");
  assert.equal(res.status, 400);
  await assertAlive(proxy);
});

test("absolute https:// request line gets 400 and does not crash", async (t) => {
  const proxy = await startProxy(t);
  const res = await rawRequest(proxy.port, "GET https://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n");
  assert.match(res, /^HTTP\/1\.1 400 /);
  await assertAlive(proxy);
});

test("upstream timeout gets 504 and does not crash", async (t) => {
  const proxy = await startProxy(t, { CROSSFERRY_TIMEOUT_MS: "300" });
  const res = await proxyRequest(proxy.port, `http://127.0.0.1:${hangPort}/`);
  assert.equal(res.status, 504);
  await assertAlive(proxy);
});

test("invalid TIMEOUT_MS falls back to the default", async (t) => {
  const proxy = await startProxy(t, { CROSSFERRY_TIMEOUT_MS: "abc" });
  const res = await proxyRequest(proxy.port, `http://127.0.0.1:${echoPort}/`);
  assert.equal(res.status, 200);
});

test("upstream dropping mid-body cuts the client connection instead of corrupting the body", async (t) => {
  const proxy = await startProxy(t);
  const err = await proxyRequest(proxy.port, `http://127.0.0.1:${brokenPort}/`).then(
    () => assert.fail("expected the response to be aborted"),
    (error) => error
  );
  assert.doesNotMatch(err.body || "", /Bad Gateway/);
  await assertAlive(proxy);
});

test("ALLOWED_IPS lets listed clients through and blocks others", async (t) => {
  const allowed = await startProxy(t, { CROSSFERRY_ALLOWED_IPS: "127.0.0.1" });
  assert.equal((await proxyRequest(allowed.port, `http://127.0.0.1:${echoPort}/`)).status, 200);
  const connect = await rawRequest(allowed.port, tunnelRequest(echoPort));
  assert.match(connect, /^HTTP\/1\.1 200 Connection Established/);

  const blocked = await startProxy(t, { CROSSFERRY_ALLOWED_IPS: "10.9.9.9" });
  assert.equal((await proxyRequest(blocked.port, `http://127.0.0.1:${echoPort}/`)).status, 403);
  assert.match(await rawRequest(blocked.port, tunnelRequest(echoPort)), /^HTTP\/1\.1 403 /);
});

test("proxy credentials and hop-by-hop headers are not forwarded upstream", async (t) => {
  const proxy = await startProxy(t, { CROSSFERRY_AUTH_USER: "alice", CROSSFERRY_AUTH_PASS: "secret" });
  const res = await proxyRequest(proxy.port, `http://127.0.0.1:${echoPort}/`, {
    headers: {
      "Proxy-Authorization": basic("alice", "secret"),
      "Proxy-Connection": "keep-alive",
      Connection: "x-private",
      "X-Private": "drop me",
      "X-Custom": "keep me",
    },
  });
  assert.equal(res.status, 200);
  const { headers } = JSON.parse(res.body);
  assert.equal(headers["proxy-authorization"], undefined);
  assert.equal(headers["proxy-connection"], undefined);
  assert.equal(headers["x-private"], undefined);
  assert.equal(headers["x-custom"], "keep me");
});

test("basic auth: colon in password, case-insensitive scheme, wrong creds", async (t) => {
  const proxy = await startProxy(t, { CROSSFERRY_AUTH_USER: "alice", CROSSFERRY_AUTH_PASS: "pa:ss" });
  const target = `http://127.0.0.1:${echoPort}/`;

  const ok = await proxyRequest(proxy.port, target, { headers: { "Proxy-Authorization": basic("alice", "pa:ss") } });
  assert.equal(ok.status, 200);

  const lower = basic("alice", "pa:ss").replace("Basic", "basic");
  assert.equal((await proxyRequest(proxy.port, target, { headers: { "Proxy-Authorization": lower } })).status, 200);

  const wrong = await proxyRequest(proxy.port, target, { headers: { "Proxy-Authorization": basic("alice", "pa") } });
  assert.equal(wrong.status, 407);
  assert.equal(wrong.headers["proxy-authenticate"], 'Basic realm="Proxy"');

  assert.match(await rawRequest(proxy.port, tunnelRequest(echoPort)), /^HTTP\/1\.1 407 /);
});

test("CONNECT tunnels to the requested port and forwards early data", async (t) => {
  const proxy = await startProxy(t);
  const res = await rawRequest(proxy.port, tunnelRequest(echoPort));
  assert.match(res, /^HTTP\/1\.1 200 Connection Established\r\n\r\nHTTP\/1\.1 200 OK/);
  assert.match(res, /"url":"\/tunneled"/);
});

test("CONNECT rejects malformed targets with 400", async (t) => {
  const proxy = await startProxy(t);
  for (const target of ["example.com", "user@example.com:443", "example.com/x:443", "example.com:0", "example.com:70000"]) {
    const res = await rawRequest(proxy.port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    assert.match(res, /^HTTP\/1\.1 400 /, target);
  }
});

test("BLOCK_PRIVATE_IPS blocks loopback targets by IP and by hostname", async (t) => {
  const proxy = await startProxy(t, { CROSSFERRY_BLOCK_PRIVATE_IPS: "true" });
  for (const host of ["127.0.0.1", "localhost"]) {
    assert.equal((await proxyRequest(proxy.port, `http://${host}:${echoPort}/`)).status, 403, host);
    assert.match(await rawRequest(proxy.port, tunnelRequest(echoPort, host)), /^HTTP\/1\.1 403 /, host);
  }
  assert.match(await rawRequest(proxy.port, tunnelRequest(443, "[::1]")), /^HTTP\/1\.1 403 /);
});

test("ALLOWED_HOST supports exact and *.wildcard entries", async (t) => {
  // .invalid never resolves (RFC 6761): allowed hosts fail at DNS (502), disallowed ones at the allowlist (403)
  const proxy = await startProxy(t, { CROSSFERRY_ALLOWED_HOSTS: "exact.invalid,*.Wild.invalid" });
  const status = async (host) => (await proxyRequest(proxy.port, `http://${host}/`)).status;

  assert.equal(await status("exact.invalid"), 502);
  assert.equal(await status("a.wild.invalid"), 502);
  assert.equal(await status("a.b.wild.invalid"), 502);
  assert.equal(await status("wild.invalid"), 403);
  assert.equal(await status("evilwild.invalid"), 403);
  assert.equal(await status("sub.exact.invalid"), 403);
});

test("chunked request bodies round-trip intact", async (t) => {
  const proxy = await startProxy(t);
  const res = await proxyRequest(proxy.port, `http://127.0.0.1:${echoPort}/upload`, {
    method: "POST",
    body: ["hello ", "chunked ", "world"],
  });
  assert.equal(res.status, 200);
  const echoed = JSON.parse(res.body);
  assert.equal(echoed.method, "POST");
  assert.equal(echoed.body, "hello chunked world");
});

test("refuses to start as an open proxy on a public interface", async (t) => {
  const err = await startProxy(t, { CROSSFERRY_HOST: "0.0.0.0" }).then(() => assert.fail("expected startup to fail"), (e) => e);
  assert.equal(err.code, 1);
  assert.match(err.output, /Refusing to run an open proxy/);

  const open = await startProxy(t, { CROSSFERRY_HOST: "0.0.0.0", CROSSFERRY_ALLOW_OPEN_PROXY: "true" });
  assert.ok(open.port > 0);
});

test("refuses to start with only one of AUTH_USER/AUTH_PASS", async (t) => {
  const err = await startProxy(t, { CROSSFERRY_AUTH_USER: "alice" }).then(() => assert.fail("expected startup to fail"), (e) => e);
  assert.equal(err.code, 1);
  assert.match(err.output, /Set both CROSSFERRY_AUTH_USER and CROSSFERRY_AUTH_PASS/);
});

// helpers

function listen(server) {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// spawns index.js with a clean env (nothing inherited from the shell) on a random port
function startProxy(t, env = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    env: { PATH: process.env.PATH, CROSSFERRY_HOST: "127.0.0.1", CROSSFERRY_PORT: "0", CROSSFERRY_BLOCK_PRIVATE_IPS: "false", ...env },
  });
  t.after(() => child.kill());

  let output = "";
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /forward proxy listening on .*:(\d+)/.exec(output);
      if (match) resolve({ port: Number(match[1]), child });
    });
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("exit", (code) => {
      const err = new Error(`proxy exited with code ${code}:\n${output}`);
      reject(Object.assign(err, { code, output }));
    });
  });
}

async function assertAlive(proxy) {
  await delay(100);
  assert.equal(proxy.child.exitCode, null, "proxy process exited");
}

function proxyRequest(proxyPort, target, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method, path: target, headers, agent: false }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      res.on("error", (err) => reject(Object.assign(err, { body: data })));
    });
    req.on("error", reject);
    for (const chunk of [].concat(body || [])) req.write(chunk);
    req.end();
  });
}

// CONNECT followed immediately by a plain HTTP request to send through the tunnel
function tunnelRequest(port, host = "127.0.0.1") {
  return (
    `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n` +
    `GET /tunneled HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`
  );
}

function rawRequest(proxyPort, text) {
  return new Promise((resolve, reject) => {
    let data = "";
    const socket = net.connect(proxyPort, "127.0.0.1", () => socket.write(text));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (data += chunk));
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
  });
}

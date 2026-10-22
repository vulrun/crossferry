const net = require("node:net");
const http = require("node:http");
const { pipeline } = require("node:stream");
const { loadConfig } = require("./config");
const {
  //
  createLogger,
  parseURL,
  getClientIp,
  isAuthValid,
  isIpAllowed,
  isHostAllowed,
  isPrivateAddress,
  safeLookup,
  stripHopByHopHeaders,
  sendSocketRes,
  writeRes,
} = require("./utils");

module.exports = { createProxyServer, startProxy, loadConfig };

// Builds the proxy server for a config; it is not listening yet. Handlers close over
// config and logger, so several instances can live in one process.
function createProxyServer(config) {
  const log = createLogger(config);
  const lookup = config.BLOCK_PRIVATE_IPS ? safeLookup : undefined;

  const server = http.createServer(handleHttpRequests);
  server.on("connect", handleHttpsTunneling);
  server.on("close", () => log.access("SERVER_CLOSED"));
  return server;

  function handleHttpRequests(req, res) {
    const clientIp = getClientIp(req);

    // Check if client IP is allowed
    if (!isIpAllowed(clientIp, config.ALLOWED_IPS)) {
      log.error("HTTP_FORBIDDEN", `Blocked IP: ${clientIp}`);
      return writeRes(res, 403, "Forbidden: you are not allowed to use this proxy");
    }

    // Check if authentication is valid
    if (!isAuthValid(req, config)) {
      log.error("HTTP_AUTH_FAIL", clientIp);
      return writeRes(res, 407, "Proxy Authentication Required", {
        "Proxy-Authenticate": 'Basic realm="Proxy"',
      });
    }

    // Proxy requests carry an absolute URL ("http://host/path"); HTTPS goes through CONNECT
    const targetUrl = parseURL(req.url);
    if (!targetUrl || targetUrl.protocol !== "http:") {
      log.error("HTTP_BAD_REQUEST", `Invalid URL: ${req.url} from ${clientIp}`);
      return writeRes(res, 400, "Bad Request: expected an absolute http:// URL");
    }

    // Check if target host is allowed
    const { hostname, port } = targetUrl;
    if (!isHostAllowed(hostname, config.ALLOWED_HOSTS)) {
      log.error("HTTP_FORBIDDEN", `Blocked Host: ${hostname}:${port} from ${clientIp}`);
      return writeRes(res, 403, "Forbidden: host not allowed by proxy allowlist");
    }

    // IP literals skip DNS lookup, so check them here
    if (config.BLOCK_PRIVATE_IPS && isPrivateAddress(hostname.replace(/^\[|\]$/g, ""))) {
      log.error("HTTP_FORBIDDEN", `Blocked private target: ${hostname} from ${clientIp}`);
      return writeRes(res, 403, "Forbidden: private address not allowed");
    }

    log.access("HTTP", req.method, req.url, "from", clientIp);

    const proxyReq = http.request(targetUrl, {
      method: req.method,
      headers: stripHopByHopHeaders(req.headers),
      timeout: config.TIMEOUT_MS,
      lookup,
    });

    proxyReq.on("response", (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, stripHopByHopHeaders(proxyRes.headers));
      pipeline(proxyRes, res, (err) => {
        if (err) log.error("HTTP_STREAM_ERROR", `${hostname}:${port || 80}`, err.message);
      });
    });

    proxyReq.on("timeout", () => {
      const err = new Error("Upstream timed out");
      err.code = "ETIMEDOUT";
      proxyReq.destroy(err);
    });

    proxyReq.on("error", (err) => {
      log.error("HTTP_UPSTREAM_ERROR", `${hostname}:${port || 80}`, err.code || "", err.message);

      if (res.writableEnded || res.destroyed) return;
      // body already streaming: cut the connection rather than append to a partial body
      if (res.headersSent) return res.destroy();

      if (err.code === "EBLOCKED") return writeRes(res, 403, "Forbidden: private address not allowed");
      if (err.code === "ETIMEDOUT") return writeRes(res, 504, "Proxy Gateway Timed Out");
      return writeRes(res, 502, "Bad Gateway");
    });

    // client went away before the response finished: stop the upstream request
    res.on("close", () => {
      if (!res.writableFinished) proxyReq.destroy();
    });

    req.pipe(proxyReq, { end: true });
  }

  function handleHttpsTunneling(req, clientSocket, head) {
    const clientIp = getClientIp(req);
    let serverSocket = null;

    clientSocket.on("error", (err) => {
      log.error("CONNECT_CLIENT_ERROR", "Socket error:", err.message);
      serverSocket?.destroy();
    });

    // Check if client IP is allowed
    if (!isIpAllowed(clientIp, config.ALLOWED_IPS)) {
      log.error("CONNECT_FORBIDDEN", `Blocked IP: ${clientIp}`);
      return sendSocketRes(clientSocket, 403, "Forbidden: you are not allowed to use this proxy");
    }

    // Check if authentication is valid
    if (!isAuthValid(req, config)) {
      log.error("CONNECT_AUTH_FAIL", clientIp);
      return sendSocketRes(clientSocket, 407, "Proxy Authentication Required", {
        "Proxy-Authenticate": 'Basic realm="Proxy"',
      });
    }

    // CONNECT target is authority-form "hostname:port" (RFC 9110 §9.3.6).
    // We use a dummy protocol to normalize the hostname with URL class, and reject
    // anything that isn't a bare hostname (userinfo, path, query, extra port)
    const [, authority, portStr] = /^(.+):(\d{1,5})$/.exec(req.url) || [];
    const targetUrl = authority ? parseURL(`http://${authority}`) : null;
    const port = Number(portStr);
    if (!targetUrl || targetUrl.href !== `http://${targetUrl.hostname}/` || port < 1 || port > 65535) {
      log.error("CONNECT_BAD_REQUEST", "Invalid URL", req.url);
      return sendSocketRes(clientSocket, 400, "Bad Request");
    }

    // Check if target host is allowed
    const { hostname } = targetUrl;
    if (!isHostAllowed(hostname, config.ALLOWED_HOSTS)) {
      log.error("CONNECT_FORBIDDEN", `Blocked Host: ${hostname} from ${clientIp}`);
      return sendSocketRes(clientSocket, 403, "Forbidden: host not allowed by proxy allowlist");
    }

    // URL keeps IPv6 literals in brackets, net.connect wants them bare
    const host = hostname.replace(/^\[|\]$/g, "");

    // IP literals skip DNS lookup, so check them here
    if (config.BLOCK_PRIVATE_IPS && isPrivateAddress(host)) {
      log.error("CONNECT_FORBIDDEN", `Blocked private target: ${hostname} from ${clientIp}`);
      return sendSocketRes(clientSocket, 403, "Forbidden: private address not allowed");
    }

    log.access("CONNECT", `${hostname}:${port}`, "from", clientIp);

    let established = false;
    serverSocket = net.connect({ host, port, lookup }, () => {
      established = true;
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on("timeout", () => {
      log.error("CONNECT_TIMEDOUT", `Tunnel to ${hostname}:${port} timed out`);
      serverSocket.destroy();
      if (established) return clientSocket.destroy();
      sendSocketRes(clientSocket, 504, "Gateway Timeout");
    });

    serverSocket.on("error", (err) => {
      log.error("CONNECT_UPSTREAM_ERROR", `${hostname}:${port}`, err.code || "", err.message);

      // once tunneled, the client is speaking TLS; an HTTP error response would be garbage
      if (established) return clientSocket.destroy();

      if (err.code === "EBLOCKED") return sendSocketRes(clientSocket, 403, "Forbidden: private address not allowed");
      sendSocketRes(clientSocket, 502, "Bad Gateway");
    });

    serverSocket.setTimeout(config.TIMEOUT_MS);
  }
}

// Loads config from env and starts listening. Resolves with { server, config, close };
// rejects on a bad config (ConfigError) or a listen failure (e.g. EADDRINUSE).
function startProxy(env = process.env, { banner = true } = {}) {
  const config = loadConfig(env);
  const server = createProxyServer(config);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: config.HOST, port: config.PORT }, () => {
      server.off("error", reject);
      if (banner) printBanner(config, server.address());
      resolve({
        server,
        config,
        // stops accepting, drops idle keep-alive connections, resolves when in-flight requests end
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeIdleConnections();
          }),
      });
    });
  });
}

function printBanner(config, address) {
  console.log(`🔰`, `CrossFerry forward proxy listening on ${config.HOST}:${address.port}`);

  if (config.REQUIRE_AUTH) {
    console.log(`🔒`, "Basic Auth enabled");
  } else {
    console.log(`📛`, "No auth configured, do NOT expose to the internet");
  }

  if (config.ALLOWED_IPS.length) {
    console.log(`✅`, "IP Allowlist:", config.ALLOWED_IPS.join(", "));
  } else {
    console.log(`⚪`, "No IP allowlist set");
  }

  if (config.ALLOWED_HOSTS.length) {
    console.log(`✅`, "Target allowlist:", config.ALLOWED_HOSTS.join(", "));
  } else {
    console.log(`⚪`, "No target allowlist set");
  }

  if (config.BLOCK_PRIVATE_IPS) {
    console.log(`🛡️`, "Private/loopback targets blocked");
  } else {
    console.log(`⚪`, "Private/loopback targets allowed");
  }
}

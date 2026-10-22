import path from "node:path";
import { serve } from "@hono/node-server";
import { fetch as undiciFetch, Agent } from "undici";
import { readServiceEnv } from "@crossferry/shared";
import { createApp, loadConfig } from "../app.js";
import { safeLookup } from "./lookup.js";

// Starts listening with a bare-named env (see readServiceEnv). Resolves with { server, config, close };
// rejects on a bad config or a listen failure (e.g. EADDRINUSE).
export function startCors(env = readServiceEnv(process.env, "cors"), { banner = true } = {}) {
  const config = loadConfig(env);

  // undici is used explicitly (not the global fetch) so the SSRF lookup hook is guaranteed to apply
  const dispatcher = new Agent({ connect: config.BLOCK_PRIVATE_IPS ? { lookup: safeLookup } : {} });
  const fetchImpl = (url, init) => undiciFetch(url, { ...init, dispatcher });
  const app = createApp(config, { fetchImpl });

  return new Promise((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        port: config.PORT,
        hostname: config.HOST,
        // keep the standard Request/Response classes; the core builds plain ones
        overrideGlobalObjects: false,
      },
      (info) => {
        server.off("error", reject);
        if (banner) printBanner(config, info);
        resolve({
          server,
          config,
          close: () =>
            new Promise((done) => {
              server.close(() => done());
              server.closeIdleConnections?.();
            }),
        });
      }
    );
    server.once("error", reject);
  });
}

function printBanner(config, info) {
  console.log(`🔰`, `CrossFerry CORS proxy listening on ${info.address}:${info.port}`);
  console.log(config.REQUIRE_HEADERS.length ? `🔒` : `📛`, config.REQUIRE_HEADERS.length ? `Required headers: ${config.REQUIRE_HEADERS.join(", ")}` : "No required headers, anyone can use this proxy");
  console.log(config.ALLOWED_ORIGINS.length ? `✅` : `⚪`, config.ALLOWED_ORIGINS.length ? `Allowed origins: ${config.ALLOWED_ORIGINS.join(", ")}` : "Any origin allowed");
  console.log(config.ALLOWED_HOSTS.length ? `✅` : `⚪`, config.ALLOWED_HOSTS.length ? `Allowed targets: ${config.ALLOWED_HOSTS.join(", ")}` : "Any target host allowed");
  console.log(config.RATE_LIMIT ? `✅` : `⚪`, config.RATE_LIMIT ? `Rate limit: ${config.RATE_LIMIT.max} per ${config.RATE_LIMIT.periodMs / 60000} min per origin` : "No rate limit");
  console.log(config.BLOCK_PRIVATE_IPS ? `🛡️` : `⚪`, config.BLOCK_PRIVATE_IPS ? "Private/loopback targets blocked" : "Private/loopback targets allowed");
}

// standalone: `node src/adapters/node.js` (npm start), same as `crossferry cors`. When imported by the CLI, nothing runs here.
const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === import.meta.filename;

if (isMain) {
  // graceful shutdown for docker stop / pm2 reload. Handlers go in before listening, so a signal
  // that lands during startup is never left to the default action; in-flight responses finish, then exit.
  let shutdown = () => Promise.resolve();
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      console.log(`🛑`, `${signal} received, shutting down`);
      shutdown().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 8000).unref();
    });
  }

  startCors(readServiceEnv(process.env, "cors"))
    .then(({ close }) => {
      shutdown = close;
    })
    .catch((err) => {
      console.error(`⛔`, err.message);
      process.exit(1);
    });
}

// Standalone entry point: runs only the forward proxy (same as `crossferry forward`).
// Settings come from CROSSFERRY_* variables; readServiceEnv maps them to the bare names loadConfig reads.
const { readServiceEnv } = require("@crossferry/shared");
const { startProxy } = require("./src/server");

// Graceful shutdown for docker stop / pm2 reload. Handlers go in before listening, so a signal
// that lands during startup is never left to the default action.
let shutdown = () => Promise.resolve();
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    console.log(`🛑`, `${signal} received, shutting down`);
    shutdown().then(() => process.exit(0));
    // open tunnels don't end on their own; force exit before Docker's 10s SIGKILL
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

startProxy(readServiceEnv(process.env, "forward"))
  .then(({ close }) => {
    shutdown = close;
  })
  .catch((err) => {
    for (const line of err.errors || [err.message]) console.error(`⛔`, line);
    process.exit(1);
  });

#!/usr/bin/env node
// CrossFerry CLI core: runs the forward HTTP/HTTPS proxy, the CORS proxy, or both in one process.
//
//   crossferry all       both services (default when no command is given)
//   crossferry forward   forward proxy only
//   crossferry cors      CORS proxy only
//
// Settings come from CROSSFERRY_* environment variables (see readServiceEnv in @crossferry/shared).
import os from "node:os";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { readServiceEnv, serviceEnabled } from "@crossferry/shared";
import { startProxy } from "@crossferry/proxy";
import { startCors } from "@crossferry/cors/node";

export const SERVICES = {
  forward: { label: "forward proxy", start: startProxy },
  cors: { label: "CORS proxy", start: startCors },
};

export const COMMANDS = {
  all: ["forward", "cors"],
  forward: ["forward"],
  cors: ["cors"],
};

// written at startup so the Docker health check knows which services to probe
export const STATE_FILE = path.join(os.tmpdir(), "crossferry-services.json");

export const USAGE = `CrossFerry — a forward HTTP/HTTPS proxy and CORS proxy, runnable together or separately.

Usage: crossferry [command]

Commands:
  all       run both services (default)
  forward   run only the forward HTTP/HTTPS proxy
  cors      run only the CORS proxy

Options:
  -h, --help     show this help
  -v, --version  print the version

Settings are read from CROSSFERRY_* environment variables (npm start also loads .env):
  CROSSFERRY_<NAME>           applies to every service that knows <NAME>
  CROSSFERRY_FORWARD_<NAME>   forward proxy only, wins over the shared value
  CROSSFERRY_CORS_<NAME>      CORS proxy only
  CROSSFERRY_PORT             forward proxy port (3128); CROSSFERRY_CORS_PORT is the CORS port (8080)
  CROSSFERRY_FORWARD_ENABLED  / CROSSFERRY_CORS_ENABLED=false skip a service under "all"
See README.md for every setting.
`;

// Starts the services a command names. Resolves with { services, close }; rejects with a message
// prefixed by the failing service's name, after stopping anything already started.
export async function start(command = "all", env = process.env) {
  const names = COMMANDS[command];
  if (!names) throw new Error(`unknown command "${command}"`);

  const running = [];
  for (const name of names) {
    if (command === "all" && !serviceEnabled(env, name)) {
      console.log(`⚪`, `${name} disabled (CROSSFERRY_${name.toUpperCase()}_ENABLED=false)`);
      continue;
    }
    try {
      const handle = await SERVICES[name].start(readServiceEnv(env, name));
      running.push({ name, handle, port: handle.server.address().port });
    } catch (err) {
      await Promise.all(running.map((s) => s.handle.close()));
      const lines = err.errors || [err.message];
      throw new Error(lines.map((line) => `[${name}] ${line}`).join("\n"));
    }
  }

  if (!running.length) throw new Error("Nothing to run: every service is disabled");

  return {
    services: running,
    close: () => Promise.all(running.map((s) => s.handle.close())),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const [command = "all", ...rest] = argv;

  if (["-h", "--help", "help"].includes(command)) {
    process.stdout.write(USAGE);
    return;
  }
  if (["-v", "--version", "version"].includes(command)) {
    console.log(await version());
    return;
  }
  if (!COMMANDS[command] || rest.length) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  // handlers go in before anything listens, so a signal during startup is never left to the default action
  let shutdown = () => Promise.resolve();
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      console.log(`🛑`, `${signal} received, shutting down`);
      shutdown().then(() => process.exit(0));
      // open proxy tunnels never end on their own; force exit before Docker's 10s SIGKILL
      setTimeout(() => process.exit(0), 8000).unref();
    });
  }

  try {
    const { services, close } = await start(command, process.env);
    shutdown = close;
    const ports = Object.fromEntries(services.map((s) => [s.name, s.port]));
    await writeFile(STATE_FILE, JSON.stringify(ports)).catch(() => {});
    console.log(`🧩`, `CrossFerry running: ${services.map((s) => `${s.name} on :${s.port}`).join(", ")}`);
  } catch (err) {
    for (const line of err.message.split("\n")) console.error(`⛔`, line);
    process.exit(1);
  }
}

async function version() {
  const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
  return `crossferry ${pkg.version}`;
}

// `node index.js [command]` behaves like the crossferry binary
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) main();

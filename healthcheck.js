// Docker HEALTHCHECK for the CrossFerry image: every running service must answer.
// The CLI records which services it started (and their ports) in a state file; without it,
// CROSSFERRY_*_ENABLED and the port variables decide what to probe.
import net from "node:net";
import { readFile } from "node:fs/promises";
import { STATE_FILE } from "./index.js";

const env = process.env;
let ports = null;
try {
  ports = JSON.parse(await readFile(STATE_FILE, "utf8"));
} catch {
  ports = {};
  if (env.CROSSFERRY_FORWARD_ENABLED !== "false") ports.forward = Number(env.CROSSFERRY_PORT || 3128);
  if (env.CROSSFERRY_CORS_ENABLED !== "false") ports.cors = Number(env.CROSSFERRY_CORS_PORT || 8080);
}

const checks = [];
if (ports.forward) checks.push(tcp(ports.forward));
if (ports.cors) {
  checks.push(
    fetch(`http://127.0.0.1:${ports.cors}/healthz`).then((res) => {
      if (!res.ok) throw new Error(`cors /healthz answered ${res.status}`);
    })
  );
}

Promise.all(checks).then(
  () => process.exit(0),
  (err) => {
    console.error(err.message);
    process.exit(1);
  }
);

function tcp(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

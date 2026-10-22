// CrossFerry reads every setting from CROSSFERRY_* environment variables, on every platform.
// This turns them into the bare names one service's loadConfig() understands:
//
//   CROSSFERRY_<NAME>           → NAME for every service that knows NAME (shared value)
//   CROSSFERRY_FORWARD_<NAME>   → NAME for the forward proxy only, overriding the shared value
//   CROSSFERRY_CORS_<NAME>      → NAME for the CORS proxy only
//   CROSSFERRY_PORT             → the forward proxy's port; the CORS proxy's is CROSSFERRY_CORS_PORT
//
// Variables without the prefix are ignored, so a host's unrelated PORT/HOST never leak in.
export const ENV_PREFIX = "CROSSFERRY_";

const INFIX = { forward: "FORWARD_", cors: "CORS_" };

export function readServiceEnv(env, service) {
  const own = INFIX[service];
  if (!own) throw new Error(`readServiceEnv: unknown service "${service}"`);
  const foreign = Object.values(INFIX).filter((infix) => infix !== own);

  const shared = {};
  const specific = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (!key.startsWith(ENV_PREFIX) || value === undefined) continue;
    const name = key.slice(ENV_PREFIX.length);

    if (name.startsWith(own)) specific[name.slice(own.length)] = value;
    else if (foreign.some((infix) => name.startsWith(infix))) continue;
    else if (name === "PORT" && service !== "forward") continue;
    else shared[name] = value;
  }

  return { ...shared, ...specific };
}

// CROSSFERRY_FORWARD_ENABLED=false / CROSSFERRY_CORS_ENABLED=false switch a service off under `crossferry all`
export function serviceEnabled(env, service) {
  const own = INFIX[service];
  if (!own) throw new Error(`serviceEnabled: unknown service "${service}"`);
  return env?.[`${ENV_PREFIX}${own}ENABLED`] !== "false";
}

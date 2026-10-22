import { readServiceEnv } from "@crossferry/shared";
import { createApp, loadConfig } from "../app.js";

// Cloudflare Workers entry. Settings are CROSSFERRY_* [vars] / secrets in wrangler.toml, handed in as `env`.
// The platform already refuses fetches to private addresses, so the literal checks in the core suffice.
let app;

export default {
  fetch(request, env, ctx) {
    app ??= createApp(loadConfig(readServiceEnv(env, "cors")));
    return app.fetch(request, env, ctx);
  },
};

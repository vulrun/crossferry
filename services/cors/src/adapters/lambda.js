import { handle, streamHandle } from "@hono/aws-lambda";
import { fetch as undiciFetch, Agent } from "undici";
import { readServiceEnv } from "@crossferry/shared";
import { createApp, loadConfig } from "../app.js";
import { safeLookup } from "./lookup.js";

const config = loadConfig(readServiceEnv(process.env, "cors"));

const dispatcher = new Agent({ connect: config.BLOCK_PRIVATE_IPS ? { lookup: safeLookup } : {} });
const app = createApp(config, { fetchImpl: (url, init) => undiciFetch(url, { ...init, dispatcher }) });

// API Gateway (REST or HTTP API) and Function URLs in BUFFERED mode: whole response in one payload (6 MB cap)
export const bufferedHandler = handle(app);

// Function URLs in RESPONSE_STREAM mode. `awslambda` exists only inside the Lambda runtime, and
// streamHandle needs it at definition time, so anywhere else (tests, local runs) this is the buffered one.
export const handler = typeof awslambda !== "undefined" ? streamHandle(app) : bufferedHandler;

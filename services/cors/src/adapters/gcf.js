import * as functions from "@google-cloud/functions-framework";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fetch as undiciFetch, Agent } from "undici";
import { readServiceEnv } from "@crossferry/shared";
import { createApp, loadConfig } from "../app.js";
import { safeLookup } from "./lookup.js";

const config = loadConfig(readServiceEnv(process.env, "cors"));

const dispatcher = new Agent({ connect: config.BLOCK_PRIVATE_IPS ? { lookup: safeLookup } : {} });
const app = createApp(config, { fetchImpl: (url, init) => undiciFetch(url, { ...init, dispatcher }) });

// Google Cloud Functions (gen2) HTTP entry point. The Functions Framework is Express and has
// already parsed every request body by the time we run, but it keeps the raw bytes on req.rawBody.
export async function cors(req, res) {
  const proto = header(req, "x-forwarded-proto")?.split(",")[0].trim() || req.protocol || "https";
  const host = header(req, "host") || "localhost";
  const url = `${proto}://${host}${req.originalUrl || req.url}`;

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers || {})) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }

  const method = req.method || "GET";
  let body;
  if (method !== "GET" && method !== "HEAD") {
    body = req.rawBody ?? (typeof req.pipe === "function" ? Readable.toWeb(req) : undefined);
  }

  const response = await app.fetch(new Request(url, { method, headers, body, duplex: "half" }));

  res.status(response.status);
  for (const [name, value] of response.headers) res.setHeader(name, value);

  if (!response.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body), res);
}

function header(req, name) {
  const value = typeof req.get === "function" ? req.get(name) : req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

functions.http("cors", cors);

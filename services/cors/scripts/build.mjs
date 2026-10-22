// Bundles the serverless entries into self-contained files so the workspace package never has to
// be published: dist/lambda/lambda.mjs (AWS Lambda) and dist/gcf/ (Google Cloud Functions).
// Workers are bundled by wrangler straight from src/; Node and Docker run src/ as-is.
import { build } from "esbuild";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");

await rm(dist, { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outExtension: { ".js": ".mjs" },
  logLevel: "info",
  // undici is CommonJS; ESM output needs a `require` for it
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
};

await build({
  ...common,
  entryPoints: { lambda: path.join(root, "src/adapters/lambda.js") },
  outdir: path.join(dist, "lambda"),
});

await build({
  ...common,
  entryPoints: { index: path.join(root, "src/adapters/gcf.js") },
  outdir: path.join(dist, "gcf"),
  // the Functions Framework is the server on Cloud Functions; it must stay a real dependency
  external: ["@google-cloud/functions-framework"],
});

await writeFile(
  path.join(dist, "gcf", "package.json"),
  JSON.stringify(
    {
      name: "crossferry-cors-gcf",
      private: true,
      type: "module",
      main: "index.mjs",
      engines: { node: ">=22" },
      dependencies: { "@google-cloud/functions-framework": "^5.0.5" },
    },
    null,
    2
  ) + "\n"
);

console.log("built dist/lambda/lambda.mjs and dist/gcf/");

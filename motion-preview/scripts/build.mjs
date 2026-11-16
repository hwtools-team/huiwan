import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [fileURLToPath(new URL("../src/main.tsx", import.meta.url))],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  outfile: fileURLToPath(new URL("../app.js", import.meta.url)),
  minify: true,
});

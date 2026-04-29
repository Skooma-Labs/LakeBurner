import * as esbuild from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const entry = path.join(projectRoot, "src", "frontend", "ts", "Webview.ts");
const out = path.join(projectRoot, "dist", "frontend", "ts", "Webview.js");

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  outfile: out,

  platform: "browser",
  format: "iife",
  target: ["es2021"],

  sourcemap: true,
  sourcesContent: true,

  minify: false,
  legalComments: "none",

  external: ["vscode"],
});

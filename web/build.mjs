// Build the static web app into dist/ (GitHub Pages ready).
import { build } from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";

const contract = process.env.DUEL_CONTRACT || "";
const network = process.env.DUEL_NETWORK || "testnet";
mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/app.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020", "safari15"],
  minify: true,
  sourcemap: false,
  outfile: "dist/app.js",
  define: {
    __DUEL_CONTRACT__: JSON.stringify(contract),
    __DUEL_NETWORK__: JSON.stringify(network),
    global: "globalThis",
    "process.env.NODE_ENV": '"production"',
  },
  inject: ["./shims.js"],
  loader: { ".svg": "dataurl", ".png": "dataurl" },
  logLevel: "warning",
});
copyFileSync("index.html", "dist/index.html");
console.log(`built dist/ for ${network} contract "${contract || "(set ?contract=)"}"`);

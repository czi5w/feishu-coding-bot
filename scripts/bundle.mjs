#!/usr/bin/env node
// Bundle bot-host into a single JS file for easy deployment.
// Usage: node scripts/bundle.mjs
//
// Output: deploy/bot-host.mjs (single file, ~500KB)
// Deploy: copy bot-host.mjs + .env to target, run with `node bot-host.mjs`
// Note:   `better-sqlite3` is a native module — it must be installed on the
//         target machine: `npm install better-sqlite3@11`

import { build } from "esbuild";
import { mkdirSync } from "fs";

mkdirSync("deploy", { recursive: true });

await build({
  entryPoints: ["packages/bot-host/dist/main.js"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "deploy/bot-host.mjs",
  // Native modules can't be bundled — mark as external
  external: ["better-sqlite3"],
  banner: {
    js: [
      "// Bundled bot-host — run with: node bot-host.mjs",
      "import { createRequire } from 'module';",
      "const require = createRequire(import.meta.url);",
    ].join("\n"),
  },
  minify: false,
  sourcemap: false,
});

console.log("✅ deploy/bot-host.mjs created");
console.log("");
console.log("Deploy to Raspberry Pi:");
console.log("  scp deploy/bot-host.mjs .env pi@<IP>:~/bot-host/");
console.log("  ssh pi@<IP>");
console.log("  cd ~/bot-host && npm install better-sqlite3@11");
console.log("  node bot-host.mjs");

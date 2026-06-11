// Auto-rebuild the web export whenever source files change.
//
// Why this exists: in this WSL setup the Expo dev server's lazy web bundle
// renders a blank page (SDK 54 async-require issue), but `expo export` produces
// a working single bundle. This watcher re-runs the export on save so the
// static server on :8082 always serves the latest build. Just refresh the page.

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const mobileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const WATCH_TARGETS = ["App.tsx", "index.ts", "app.json", "src"];
const DEBOUNCE_MS = 400;

let building = false;
let pending = false;
let timer = null;

function runExport() {
  if (building) {
    pending = true;
    return;
  }
  building = true;
  const startedAt = Date.now();
  console.log(`\n[watch-web] rebuilding web export...`);
  const child = spawn("npm", ["run", "export:web"], {
    cwd: mobileDir,
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env
  });
  child.on("exit", (code) => {
    building = false;
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (code === 0) {
      console.log(`[watch-web] done in ${secs}s — refresh http://localhost:8082`);
    } else {
      console.log(`[watch-web] export failed (exit ${code}) — fix errors and save again`);
    }
    if (pending) {
      pending = false;
      scheduleBuild();
    }
  });
}

function scheduleBuild() {
  clearTimeout(timer);
  timer = setTimeout(runExport, DEBOUNCE_MS);
}

for (const target of WATCH_TARGETS) {
  const full = path.join(mobileDir, target);
  try {
    watch(full, { recursive: true }, (_event, filename) => {
      if (filename && /\.(tsx?|json)$/.test(filename)) {
        scheduleBuild();
      } else if (!filename) {
        scheduleBuild();
      }
    });
    console.log(`[watch-web] watching ${target}`);
  } catch (err) {
    console.log(`[watch-web] could not watch ${target}: ${err.message}`);
  }
}

console.log("[watch-web] initial build...");
runExport();

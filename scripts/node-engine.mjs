#!/usr/bin/env node
// Picks the Node.js version for a runtime build, given what the harness asks for.
//
//   node-engine.mjs choose <engines.node range or ""> <pinned version> [<node of the previous release>]
//     Prints one JSON line: {ok, nodeVersion, changedFromPin, note} or {ok:false, error}.
//     Rule: start from the pinned version in versions.env (or the Node of the previous
//     release when that is newer and has the same major, so consecutive releases do not
//     churn the base layer). If that satisfies the range, use it. Otherwise use the newest
//     release of the SAME major that satisfies it. A harness that needs another major
//     fails here, on purpose: the module pack was validated on one major only.
//
//   node-engine.mjs explain <engines.node range or ""> <bundled node version>
//     Prints a plain sentence saying whether the bundled Node meets the harness requirement.
//     Used in failure messages. Always exits 0.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { join } from "node:path";

function loadSemver() {
  const require = createRequire(import.meta.url);
  try { return require("semver"); } catch { /* fall through to the copy bundled with npm */ }
  const roots = [];
  try { roots.push(execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); } catch { /* no npm */ }
  roots.push(join(process.execPath, "..", "..", "lib", "node_modules"));
  for (const r of roots) {
    try { return require(join(r, "npm", "node_modules", "semver")); } catch { /* next */ }
  }
  throw new Error("semver is not available (install it with: npm install semver)");
}

const semver = loadSemver();
const [cmd, rangeArg = "", ...rest] = process.argv.slice(2);
const range = rangeArg.trim();
const meets = (v) => !range || range === "*" || semver.satisfies(v, range);

if (cmd === "explain") {
  const bundled = rest[0];
  if (!range) console.log(`The harness declares no Node.js requirement; the bundle ships Node ${bundled}.`);
  else if (meets(bundled)) console.log(`The harness asks for Node ${range}; the bundle ships Node ${bundled}, which meets that.`);
  else console.log(`The harness asks for Node ${range} but the bundle ships Node ${bundled}, which does not meet it. ` +
    "That is the likely reason it does not start.");
  process.exit(0);
}

if (cmd !== "choose") { console.error("usage: node-engine.mjs choose|explain ..."); process.exit(2); }

const [pinned, previous = ""] = rest;
if (!semver.valid(pinned)) { console.error(`bad pinned version '${pinned}'`); process.exit(2); }
const major = semver.major(pinned);
let base = pinned;
if (semver.valid(previous) && semver.major(previous) === major && semver.gt(previous, base)) base = previous;

if (meets(base)) {
  console.log(JSON.stringify({ ok: true, nodeVersion: base, changedFromPin: base !== pinned,
    note: range ? `harness asks for Node ${range}; Node ${base} meets it` : "harness declares no Node.js requirement" }));
  process.exit(0);
}

let index;
try {
  const res = await fetch("https://nodejs.org/dist/index.json");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  index = await res.json();
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: `Node ${base} does not meet the harness requirement (${range}) and the Node release list could not be read: ${e.message}` }));
  process.exit(0);
}
const candidates = index
  .filter((r) => r.version.startsWith(`v${major}.`) && r.files?.includes("linux-x64") && r.files?.includes("linux-arm64"))
  .map((r) => r.version.slice(1))
  .filter((v) => semver.valid(v) && meets(v))
  .sort(semver.rcompare);
if (candidates.length) {
  console.log(JSON.stringify({ ok: true, nodeVersion: candidates[0], changedFromPin: true,
    note: `harness asks for Node ${range}; Node ${base} does not meet it, so the base layer is rebuilt with Node ${candidates[0]}` }));
} else {
  console.log(JSON.stringify({ ok: false,
    error: `The harness asks for Node ${range} but this runtime ships Node ${major}.x (${base}) and no Node ${major}.x release meets that. ` +
      `Nothing was published. If it needs a new Node major, that is a deliberate change: bump NODE_VERSION in ` +
      `scripts/versions.env, check the module pack on the new Node, then run the workflow by hand.` }));
}

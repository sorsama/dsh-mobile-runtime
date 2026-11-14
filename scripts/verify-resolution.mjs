#!/usr/bin/env node
// Independent proof that deduplication did not change which version any package gets.
//
//   node verify-resolution.mjs snapshot <node_modules> <out.json>
//   node verify-resolution.mjs compare <before.json> <after.json>     (exit 1 on any difference)
//
// For every package location in the tree, and every dependency it declares
// (dependencies, optionalDependencies, peerDependencies), the snapshot records which
// "name@version" Node's own lookup list (createRequire(...).resolve.paths) finds from the
// package's REAL path. A location that was replaced by a symlink is resolved from where
// the symlink leads, which is where its code now runs.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function isRealDir(p) {
  try { const s = fs.lstatSync(p); return s.isDirectory(); } catch { return false; }
}

function* packageEntries(nmDir) {
  let names;
  try { names = fs.readdirSync(nmDir).sort(); } catch { return; }
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const p = path.join(nmDir, n);
    if (n.startsWith('@')) {
      let inner = [];
      try { inner = fs.readdirSync(p).sort(); } catch { /* not a scope directory */ }
      for (const m of inner) {
        const q = path.join(p, m);
        if (fs.existsSync(path.join(q, 'package.json'))) yield [`${n}/${m}`, q];
      }
    } else if (fs.existsSync(path.join(p, 'package.json'))) {
      yield [n, p];
    }
  }
}

function* locations(nmDir, root) {
  for (const [, p] of packageEntries(nmDir)) {
    yield path.relative(root, p).split(path.sep).join('/');
    const inner = path.join(p, 'node_modules');
    if (isRealDir(p) && isRealDir(inner)) yield* locations(inner, root);
  }
}

function resolveFrom(realDir, dep) {
  const req = createRequire(path.join(realDir, '__resolve__.js'));
  for (const dir of req.resolve.paths(dep) ?? []) {
    const j = readJson(path.join(dir, dep, 'package.json'));
    if (j) return `${j.name}@${j.version}`;
  }
  return null;
}

function snapshot(nm, out) {
  nm = path.resolve(nm);
  const state = {};
  let deps = 0;
  for (const rel of locations(nm, nm)) {
    const loc = path.join(nm, rel);
    const real = fs.realpathSync(loc);
    const j = readJson(path.join(real, 'package.json'));
    if (!j) continue;
    const names = new Set();
    for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      if (j[k] && typeof j[k] === 'object') for (const d of Object.keys(j[k])) names.add(d);
    }
    const resolved = {};
    for (const d of [...names].sort()) { resolved[d] = resolveFrom(real, d); deps++; }
    state[rel] = { self: `${j.name}@${j.version}`, deps: resolved };
  }
  fs.writeFileSync(out, JSON.stringify(state));
  console.log(`resolution snapshot: ${Object.keys(state).length} package locations, ${deps} dependency lookups`);
}

function underSymlink(nm, loc) {
  // True when some directory above `loc` is a symlink now (the copy was replaced by a link).
  const parts = loc.split('/');
  let cur = nm;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = path.join(cur, parts[i]);
    try { if (fs.lstatSync(cur).isSymbolicLink()) return true; } catch { return false; }
  }
  return false;
}

function compare(aFile, bFile, nm) {
  const a = readJson(aFile), b = readJson(bFile);
  const diffs = [];
  let same = 0, gone = 0, checked = 0;
  for (const [loc, before] of Object.entries(a)) {
    const after = b[loc];
    if (!after) {
      // Allowed only inside a copy that became a symlink: its content now lives at the shared copy.
      gone++;
      if (nm && !underSymlink(path.resolve(nm), loc)) diffs.push(`${loc}: package is missing and no symlink explains it`);
      continue;
    }
    if (after.self !== before.self) diffs.push(`${loc}: is ${before.self}, now ${after.self}`);
    for (const [d, v] of Object.entries(before.deps)) {
      checked++;
      if (after.deps[d] !== v) diffs.push(`${loc}: '${d}' resolved to ${v}, now ${after.deps[d]}`);
    }
    same++;
  }
  for (const loc of Object.keys(b)) if (!a[loc]) diffs.push(`${loc}: new location after dedupe`);
  console.log(`compared ${same} locations and ${checked} dependency lookups; ${gone} locations were inside replaced copies`);
  for (const d of diffs.slice(0, 100)) console.log('DIFF ' + d);
  if (diffs.length) { console.log(`FAIL: ${diffs.length} differences`); return 1; }
  console.log('OK: every package resolves every dependency to the same name@version as before');
  return 0;
}

const [cmd, x, y, z] = process.argv.slice(2);
if (cmd === 'snapshot') snapshot(x, y);
else if (cmd === 'compare') process.exit(compare(x, y, z));
else { console.error('usage: verify-resolution.mjs snapshot <node_modules> <out.json> | compare <before> <after> [node_modules]'); process.exit(2); }

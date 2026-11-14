// Module pack RECORDER (main part). Used only by the CI build (scripts/module-pack/drive.mjs); never shipped.
//
//   node --import record.mjs /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web ...
//
// While the harness starts and answers the calls in calls.json, this records what Node's
// module system and a few fs calls produced for files under /opt/dsh. On SIGUSR2 it writes
// <DSH_PACK_OUT>/pack.bin and <DSH_PACK_OUT>/pack-summary.json. See replay.mjs for the
// pack format and README.md ("Startup: the module pack") for what is and is not served.
//
// Env: DSH_PACK_OUT (directory), DSH_PACK_BUILD_ID, DSH_PACK_ROOT (default /opt/dsh).
import * as nodeModule from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.DSH_PACK_ROOT || '/opt/dsh';
const ROOT_URL = 'file://' + ROOT + '/';
const OUT = process.env.DSH_PACK_OUT;
const BUILD_ID = process.env.DSH_PACK_BUILD_ID;
if (!OUT || !BUILD_ID) throw new Error('record.mjs needs DSH_PACK_OUT and DSH_PACK_BUILD_ID');
if (typeof nodeModule.registerHooks !== 'function') throw new Error('module.registerHooks is not available in this Node.js');

const inTreePath = (p) => typeof p === 'string' && (p === ROOT || p.startsWith(ROOT + '/')) && path.posix.normalize(p) === p;
const inTreeUrl = (u) => typeof u === 'string' && u.startsWith(ROOT_URL) && !u.includes('/../') && !u.includes('/./');

// A source is recorded for a file URL together with the format hint the loader was given
// (require() passes none), and replayed only for that same pair.
const lkey = (url, ctx) => url + '\0' + (ctx.format ?? '');
const rkey = (spec, ctx) => spec + '\0' + (ctx.parentURL || '') + '\0' + (ctx.conditions || []).join(',') + '\0' + JSON.stringify(ctx.importAttributes || {});

const resolveMap = new Map();
const sources = new Map();
const fsMap = new Map();
const stats = { resolveSeen: 0, resolveRecorded: 0, loadSeen: 0, nullSource: {}, formats: {} };

nodeModule.registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    try {
      stats.resolveSeen++;
      const parentIn = inTreeUrl(ctx.parentURL);
      const specAbs = spec.startsWith(ROOT_URL) || spec.startsWith(ROOT + '/');
      // Only answers that cannot depend on anything outside the harness tree are recorded:
      // the importer is inside the tree (or the specifier is an absolute path inside it),
      // and the result is inside the tree or a Node.js built-in.
      if ((parentIn || specAbs) && (inTreeUrl(r.url) || r.url.startsWith('node:'))) {
        resolveMap.set(rkey(spec, ctx), { url: r.url, format: r.format ?? null });
        stats.resolveRecorded++;
      }
    } catch { /* recording is best effort */ }
    return r;
  },
  load(url, ctx, next) {
    const r = next(url, ctx);
    try {
      stats.loadSeen++;
      if (inTreeUrl(url)) {
        const f = r.format;
        stats.formats[f] = (stats.formats[f] || 0) + 1;
        if (r.source == null) stats.nullSource[f] = (stats.nullSource[f] || 0) + 1;
        else if ((f == null || f === 'module' || f === 'commonjs' || f === 'json') && !sources.has(lkey(url, ctx))) {
          sources.set(lkey(url, ctx), { format: f ?? null, source: r.source });
        }
      }
    } catch { /* recording is best effort */ }
    return r;
  },
});

const originals = {
  exists: fs.existsSync,
  realpath: fs.realpathSync,
  realpathNative: fs.realpathSync.native,
  readlink: fs.readlinkSync,
};

function wrap(obj, name, tag) {
  const orig = obj[name];
  obj[name] = function (p, ...rest) {
    if (rest.length === 0 && inTreePath(p)) {
      const k = tag + '\0' + p;
      try {
        const v = orig.call(this, p);
        if (!fsMap.has(k)) fsMap.set(k, { v });
        return v;
      } catch (e) {
        if (!fsMap.has(k)) fsMap.set(k, { e: e.code, msg: e.message, syscall: e.syscall, errno: e.errno });
        throw e;
      }
    }
    return orig.call(this, p, ...rest);
  };
  Object.assign(obj[name], orig);
}
wrap(fs, 'existsSync', 'exists');
wrap(fs, 'realpathSync', 'realpath');
wrap(fs.realpathSync, 'native', 'realpathNative');
wrap(fs, 'readlinkSync', 'readlink');

// Which package.json files under the tree does the harness read with fs.readFileSync?
// Only the paths are noted here; the bytes are read from the tree when the pack is written.
const READ_MAX = 1 << 20;
const readPaths = new Set();
const origReadFileSync = fs.readFileSync;
fs.readFileSync = function readFileSync(p, ...rest) {
  try { if (rest.length <= 1 && typeof p === 'string' && p.endsWith('/package.json') && inTreePath(p)) readPaths.add(p); } catch { /* best effort */ }
  return origReadFileSync.call(this, p, ...rest);
};
nodeModule.syncBuiltinESMExports();

// Does the real tree still say what was recorded, and does the answer stay inside the tree?
function verifyFs(tag, p, entry) {
  const call = { exists: originals.exists, realpath: originals.realpath, realpathNative: originals.realpathNative, readlink: originals.readlink }[tag];
  let now;
  try { now = { v: call(p) }; } catch (e) { now = { e: e.code, msg: e.message }; }
  if ('v' in entry ? !('v' in now) || now.v !== entry.v : !('e' in now) || now.e !== entry.e) return 'changed during the recording';
  // The deepest existing ancestor directory must really be inside the tree.
  let anc = path.posix.dirname(p);
  for (;;) {
    try { const rp = originals.realpath(anc); if (!inTreePath(rp)) return 'path leads outside the tree'; break; } catch { /* go up */ }
    if (anc === '/' || anc === ROOT) break;
    anc = path.posix.dirname(anc);
  }
  if (tag === 'exists' && entry.v === true) { try { if (!inTreePath(originals.realpath(p))) return 'exists through a link that leaves the tree'; } catch { return 'vanished'; } }
  if ((tag === 'realpath' || tag === 'realpathNative') && 'v' in entry && !inTreePath(entry.v)) return 'result is outside the tree';
  return null;
}

function dump() {
  fs.mkdirSync(OUT, { recursive: true });
  const dropped = {};
  const fsOut = {};
  for (const k of [...fsMap.keys()].sort()) {
    const [tag, p] = k.split('\0');
    const why = verifyFs(tag, p, fsMap.get(k));
    if (why) { dropped[why] = (dropped[why] || 0) + 1; continue; }
    fsOut[k] = fsMap.get(k);
  }
  const resolveOut = {};
  for (const k of [...resolveMap.keys()].sort()) resolveOut[k] = resolveMap.get(k);
  const mods = {};
  const parts = [];
  let off = 0;
  for (const url of [...sources.keys()].sort()) {
    const v = sources.get(url);
    const buf = typeof v.source === 'string' ? Buffer.from(v.source) : Buffer.from(v.source.buffer, v.source.byteOffset, v.source.byteLength);
    mods[url] = { f: v.format, o: off, n: buf.length };
    parts.push(buf);
    off += buf.length;
  }
  // package.json files the harness read with fs.readFileSync (same blob, own index).
  const files = {};
  for (const p of [...readPaths].sort()) {
    const why = verifyFs('exists', p, { v: true });
    if (why) { dropped['package.json ' + why] = (dropped['package.json ' + why] || 0) + 1; continue; }
    let buf;
    try { buf = origReadFileSync(p); } catch { dropped['package.json unreadable'] = (dropped['package.json unreadable'] || 0) + 1; continue; }
    if (buf.length > READ_MAX) continue;
    files[p] = { o: off, n: buf.length };
    parts.push(buf);
    off += buf.length;
  }
  const blob = Buffer.concat(parts);
  const guards = [];
  const lockfile = ROOT + '/node_modules/.package-lock.json';
  try { guards.push({ path: lockfile, size: fs.statSync(lockfile).size }); } catch { /* no hidden lockfile */ }
  const header = {
    format: 1,
    buildId: BUILD_ID,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    root: ROOT,
    guards,
    blobLength: blob.length,
    resolve: resolveOut,
    fs: fsOut,
    files,
    mods,
  };
  const headerBuf = Buffer.from(JSON.stringify(header));
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(headerBuf.length);
  const packBuf = Buffer.concat([Buffer.from('DSHPACK1'), lenBuf, headerBuf, blob, Buffer.from('DSHPEND1')]);
  const tmp = path.join(OUT, 'pack.bin.tmp');
  fs.writeFileSync(tmp, packBuf);
  fs.renameSync(tmp, path.join(OUT, 'pack.bin'));
  const summary = {
    buildId: BUILD_ID, node: process.version, arch: process.arch, packBytes: packBuf.length,
    headerBytes: headerBuf.length, blobBytes: blob.length,
    modules: Object.keys(mods).length, resolveEntries: Object.keys(resolveOut).length, fsEntries: Object.keys(fsOut).length, packageJsonFiles: Object.keys(files).length,
    fsDropped: dropped, resolveSeen: stats.resolveSeen, resolveRecorded: stats.resolveRecorded,
    loadSeen: stats.loadSeen, inTreeFormats: stats.formats, inTreeNullSource: stats.nullSource,
  };
  fs.writeFileSync(path.join(OUT, 'pack-summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, '.done'), 'ok');
}

process.on('SIGUSR2', () => {
  try { dump(); } catch (e) { try { fs.writeFileSync(path.join(OUT, '.failed'), String(e && e.stack || e)); } catch { /* nothing else to do */ } }
});

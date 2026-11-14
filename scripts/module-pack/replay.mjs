// Module pack REPLAY. Shipped as /opt/dsh/runtime-pack/replay.mjs and loaded by preload.mjs.
//
// What it does: answers Node's module resolve and load steps, and a few fs probes, for
// files under /opt/dsh from one pack file recorded at build time, so a start does not pay
// proot for tens of thousands of path system calls. Anything it cannot answer goes to the
// normal Node.js code path. It is OFF unless every check below passes.
//
// Pack file (/opt/dsh/runtime-pack/pack.bin):
//   "DSHPACK1" | u32le header length | header JSON | blob | "DSHPEND1"
//   header: { format, buildId, node, platform, arch, root, guards, blobLength, resolve, fs, files, mods }
//   resolve: "specifier \0 parentURL \0 conditions \0 attributes" -> { url, format }
//   fs:      "kind \0 path" -> { v } or { e, msg, syscall, errno }   (existsSync, realpathSync,
//            realpathSync.native, readlinkSync)
//   files:   package.json path -> { o, n } into the blob: what fs.readFileSync(path[, "utf8"]) returns
//   mods:    "file URL \0 format hint" -> { f: format, o: offset, n: length } into the blob; the
//            format is module, commonjs, json, or null (require() of CommonJS gives no hint)
//
// Rules that keep it safe:
//   * Only paths and file URLs under /opt/dsh are in the pack, so nothing under the user's
//     home, a workspace or a plugin installed later is ever served from it.
//   * It checks, once, with one small read: pack magic and size, the build id against
//     /opt/dsh/build-id, the Node.js version, platform and CPU architecture, and the size of
//     /opt/dsh/node_modules/.package-lock.json. Any mismatch or read or parse error turns
//     the pack off. There are no per-file checks.
//   * Every hook and every fs wrapper falls back to Node.js on a miss and on any exception.
//   * It never writes to stdout. A failed check prints one line to stderr.
import * as nodeModule from 'node:module';
import fs from 'node:fs';

const ROOT = '/opt/dsh';
const PACK_FILE = ROOT + '/runtime-pack/pack.bin';
const BUILD_ID_FILE = ROOT + '/build-id';
const debug = process.env.DSH_RUNTIME_MODULE_PACK_DEBUG === '1';

function say(text) {
  try { process.stderr.write('dsh module pack: ' + text + '\n'); } catch { /* stderr may be closed */ }
}

function load() {
  if (typeof nodeModule.registerHooks !== 'function') return 'this Node.js has no module.registerHooks';
  const wantedId = fs.readFileSync(BUILD_ID_FILE, 'utf8').trim(); // the one cheap read
  const buf = fs.readFileSync(PACK_FILE);
  if (buf.length < 20) return 'pack file is too short';
  if (buf.toString('latin1', 0, 8) !== 'DSHPACK1' || buf.toString('latin1', buf.length - 8) !== 'DSHPEND1') return 'pack file has the wrong magic';
  const headerLength = buf.readUInt32LE(8);
  const blobStart = 12 + headerLength;
  if (blobStart > buf.length - 8) return 'pack header is cut off';
  const header = JSON.parse(buf.toString('utf8', 12, blobStart));
  if (header.format !== 1) return 'unknown pack format';
  if (typeof header.blobLength !== 'number' || blobStart + header.blobLength + 8 !== buf.length) return 'pack file has the wrong size (truncated?)';
  if (!wantedId || header.buildId !== wantedId) return 'pack build id does not match /opt/dsh/build-id (stale pack)';
  if (header.root !== ROOT) return 'pack was recorded for another root';
  if (header.node !== process.version || header.platform !== process.platform || header.arch !== process.arch) {
    return `pack was recorded for node ${header.node} ${header.platform}/${header.arch}, this is node ${process.version} ${process.platform}/${process.arch}`;
  }
  for (const g of header.guards) {
    if (fs.statSync(g.path).size !== g.size) return `${g.path} changed since the pack was recorded`;
  }
  const { resolve: resolveTable, fs: fsTable, mods, files } = header;
  for (const m of [...Object.values(mods), ...Object.values(files)]) {
    if (!(m.o >= 0 && m.n >= 0 && m.o + m.n <= header.blobLength)) return 'pack index is damaged';
  }
  const blob = buf.subarray(blobStart, blobStart + header.blobLength);
  const hit = { resolve: 0, load: 0, fs: 0 };
  const miss = { resolve: 0, load: 0 };
  // Debug aid: DSH_RUNTIME_MODULE_PACK_MISSES=<file> lists what the pack could not answer, at exit.
  const missFile = debug ? process.env.DSH_RUNTIME_MODULE_PACK_MISSES : undefined;
  const missLog = missFile ? [] : null;

  const rkey = (spec, ctx) => spec + '\0' + (ctx.parentURL || '') + '\0' + (ctx.conditions || []).join(',') + '\0' + JSON.stringify(ctx.importAttributes || {});
  nodeModule.registerHooks({
    resolve(spec, ctx, next) {
      try {
        const e = resolveTable[rkey(spec, ctx)];
        if (e !== undefined) { hit.resolve++; return { url: e.url, format: e.format ?? undefined, shortCircuit: true }; }
        miss.resolve++;
        if (missLog) missLog.push('resolve ' + spec + ' <- ' + (ctx.parentURL || ''));
      } catch { /* fall through to Node.js */ }
      return next(spec, ctx);
    },
    load(url, ctx, next) {
      try {
        const m = mods[url + '\0' + (ctx.format ?? '')];
        if (m !== undefined) {
          hit.load++;
          return { format: m.f ?? undefined, source: blob.subarray(m.o, m.o + m.n), shortCircuit: true };
        }
        if (url.startsWith('file:')) {
          miss.load++;
          if (missLog) missLog.push('load ' + url + ' format=' + ctx.format);
        }
      } catch { /* fall through to Node.js */ }
      return next(url, ctx);
    },
  });

  const wrapFs = (obj, name, tag) => {
    const orig = obj[name];
    const wrapped = function (p, ...rest) {
      if (rest.length === 0 && typeof p === 'string') {
        const e = fsTable[tag + '\0' + p];
        if (e !== undefined) {
          hit.fs++;
          if (!('e' in e)) return e.v;
          const err = new Error(e.msg);
          err.errno = e.errno; err.code = e.e; err.syscall = e.syscall; err.path = p;
          throw err;
        }
      }
      return orig.call(this, p, ...rest);
    };
    Object.assign(wrapped, orig);
    obj[name] = wrapped;
  };
  wrapFs(fs, 'existsSync', 'exists');
  wrapFs(fs, 'realpathSync', 'realpath');
  wrapFs(fs.realpathSync, 'native', 'realpathNative');
  wrapFs(fs, 'readlinkSync', 'readlink');

  // fs.readFileSync of a package.json under /opt/dsh, as a Buffer or as a UTF-8 string.
  const origReadFileSync = fs.readFileSync;
  const wantedEncoding = (opts) => {
    if (opts === undefined || opts === null) return null; // a Buffer
    if (opts === 'utf8' || opts === 'utf-8') return 'utf8';
    if (typeof opts === 'object' && Object.keys(opts).length === 1 && (opts.encoding === 'utf8' || opts.encoding === 'utf-8')) return 'utf8';
    return undefined; // anything else (flags, other encodings, ...) goes to Node.js
  };
  fs.readFileSync = function readFileSync(p, ...rest) {
    if (rest.length <= 1 && typeof p === 'string') {
      const e = files[p];
      if (e !== undefined) {
        const enc = wantedEncoding(rest[0]);
        if (enc === 'utf8') { hit.fs++; return blob.toString('utf8', e.o, e.o + e.n); }
        if (enc === null) { hit.fs++; return Buffer.from(blob.subarray(e.o, e.o + e.n)); }
      }
    }
    return origReadFileSync.call(this, p, ...rest);
  };
  nodeModule.syncBuiltinESMExports();

  if (debug) {
    say(`on: ${Object.keys(mods).length} modules, ${Object.keys(resolveTable).length} resolves, ${Object.keys(fsTable).length} fs answers, build ${header.buildId}`);
    process.on('exit', () => {
      say(`stats: resolve hit ${hit.resolve} miss ${miss.resolve}, load hit ${hit.load} miss ${miss.load}, fs hit ${hit.fs}`);
      if (missLog) { try { fs.writeFileSync(missFile, missLog.join('\n') + '\n'); } catch { /* debug only */ } }
    });
  }
  return null;
}

let problem;
try { problem = load(); } catch (e) { problem = 'could not use the pack (' + ((e && e.code) || (e && e.message) || e) + ')'; }
if (problem) say('off: ' + problem);
export const off = problem || null;

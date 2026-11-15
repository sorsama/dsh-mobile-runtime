// Records the module pack: starts the harness with record.mjs, waits for readiness,
// exchanges the launch token, makes the calls in calls.json, then asks the recorder to dump.
// CI only. The launch token is never printed or written anywhere.
//
//   record: node drive.mjs --mode record --node /opt/node/bin/node --bin <dsh lib/bin.js> \
//             --record <record.mjs> --calls <calls.json> --out <dir> --build-id <id> --work <scratch dir>
//   replay: node drive.mjs --mode replay --node ... --bin ... --preload <preload.mjs> --calls ... --work ...
//           (same calls with the pack on; prints the pack's hit and miss counts and fails if it is off)
// Both take an optional --patch <file>: passed to `dsh web` like the launcher does, so the pack is
// recorded and checked with the same permission presets the shipped bundle starts with.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const REPLAY = args.mode === 'replay';
for (const k of ['node', 'bin', 'calls', 'work', ...(REPLAY ? ['preload'] : ['record', 'out', 'build-id'])]) if (!args[k]) { console.error(`missing --${k}`); process.exit(2); }

const redact = (s) => s.replace(/token=[A-Za-z0-9._~%-]+/g, 'token=<redacted>').replace(/(dsh-auth-[^=;]*=)[^;\s]+/g, '$1<redacted>');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

const work = path.resolve(args.work);
const home = path.join(work, 'home'), tmp = path.join(work, 'tmp'), ws = path.join(work, 'workspace');
for (const d of [home, tmp, ws]) fs.mkdirSync(d, { recursive: true });
if (!REPLAY) {
  fs.rmSync(args.out, { recursive: true, force: true });
  fs.mkdirSync(args.out, { recursive: true });
}

const port = await freePort();
const env = {
  HOME: home, USER: 'root', LOGNAME: 'root', LANG: 'C.UTF-8', TERM: 'dumb', TMPDIR: tmp,
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin',
  ...(REPLAY ? { DSH_RUNTIME_MODULE_PACK_DEBUG: '1', ...(process.env.DSH_RUNTIME_MODULE_PACK_MISSES ? { DSH_RUNTIME_MODULE_PACK_MISSES: process.env.DSH_RUNTIME_MODULE_PACK_MISSES } : {}) } : { DSH_PACK_OUT: args.out, DSH_PACK_BUILD_ID: args['build-id'] }),
};
const child = spawn(args.node, ['--import', REPLAY ? args.preload : args.record, args.bin, 'web', ...(args.patch ? ['--patch', args.patch] : []), '--no-open', '--port', String(port)], { env, cwd: ws, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '', err = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });
let exited = false;
child.on('exit', () => { exited = true; });

async function fail(msg) {
  console.error('FAIL: ' + msg);
  console.error('--- harness stdout (redacted)\n' + redact(out).slice(-3000));
  console.error('--- harness stderr (redacted)\n' + redact(err).slice(-3000));
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  process.exit(1);
}

const prefix = `dsh web: http://127.0.0.1:${port}/?token=`;
const deadline = Date.now() + 300000;
let token = null;
while (!token) {
  const line = out.split('\n').find((l) => l.startsWith(prefix));
  if (line) token = line.slice(prefix.length).trim();
  else if (exited) await fail('the harness exited before the readiness line');
  else if (Date.now() > deadline) await fail('no readiness line after 300 s');
  else await sleep(50);
}
console.log('readiness line seen');

const base = `http://127.0.0.1:${port}`;
const noCookie = await fetch(`${base}/api/session/list`, { method: 'POST' });
console.log('no cookie ->', noCookie.status);
const ex = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (ex.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
console.log('token exchange ->', ex.status, cookie ? '(cookie set)' : '(no cookie)');
if (!cookie) await fail('no session cookie after the token exchange');

const spec = JSON.parse(fs.readFileSync(args.calls, 'utf8'));
const subst = { '@WORKSPACE@': ws, '@SESSION_ID@': '' };
const sub = (v) => (typeof v === 'string' ? v.replace(/@WORKSPACE@|@SESSION_ID@/g, (m) => subst[m]) : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v);
let n = 0, ok = 0;
for (const c of spec.calls) {
  n++;
  const res = await fetch(`${base}/api/${c.method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `rec-${n}`, method: c.method, payload: { args: sub(c.args) } }),
  });
  const body = await res.json().catch(() => null);
  const good = res.status === 200 && body?.result?.ok === true;
  if (good) ok++;
  if (c.save && good) subst['@SESSION_ID@'] = body.result.value[c.save] ?? '';
  console.log(`call ${c.method} -> ${res.status} ${good ? 'ok' : 'not ok'}`);
}
// The page and the assets it names, like a browser's first load.
const page = await fetch(`${base}/`, { headers: { cookie } });
const html = await page.text();
console.log('GET / ->', page.status, html.length, 'bytes');
const assets = [...html.matchAll(/(?:src|href)="(\.?\/?[^"#?]+\.(?:js|css|mjs|json|svg|png|ico))"/g)].map((m) => m[1]).slice(0, 6);
for (const a of assets) {
  const u = new URL(a, base + '/');
  if (u.origin !== base) continue;
  const r = await fetch(u, { headers: { cookie } });
  await r.arrayBuffer();
  console.log('GET', u.pathname, '->', r.status);
}
console.log(`${ok} of ${n} calls ok`);

if (REPLAY) {
  child.kill('SIGTERM');
  for (let i = 0; i < 100 && !exited; i++) await sleep(100);
  if (!exited) child.kill('SIGKILL');
  const lines = redact(err).split('\n').filter((l) => l.startsWith('dsh module pack:'));
  for (const l of lines) console.log(l);
  if (!lines.some((l) => l.startsWith('dsh module pack: on:'))) await fail('the module pack was not switched on');
  const m = lines.join('\n').match(/stats: resolve hit (\d+) miss (\d+), load hit (\d+) miss (\d+), fs hit (\d+)/);
  if (!m) await fail('no stats line from the pack (the harness did not run its exit handlers)');
  const [rh, rm, lh, lm, fh] = m.slice(1).map(Number);
  // The calls are the ones that were recorded, so nearly everything must be answered by the pack.
  // The misses are resolves started from the user's profile directory, which are never served.
  if (rh < 0.8 * (rh + rm) || lm > 0.02 * (lh + lm) || fh < 1000) await fail(`the pack answers too little: ${m[0]}`);
  console.log(`pack coverage ok: ${Math.round((100 * rh) / (rh + rm))}% of resolves, ${Math.round((100 * lh) / (lh + lm))}% of loads`);
  process.exit(0);
}
child.kill('SIGUSR2');
const dumpDeadline = Date.now() + 120000;
const done = path.join(args.out, '.done'), failed = path.join(args.out, '.failed');
while (!fs.existsSync(done)) {
  if (fs.existsSync(failed)) await fail('the recorder failed: ' + fs.readFileSync(failed, 'utf8'));
  if (exited) await fail('the harness exited before the pack was written');
  if (Date.now() > dumpDeadline) await fail('the pack was not written within 120 s');
  await sleep(100);
}
child.kill('SIGTERM');
for (let i = 0; i < 100 && !exited; i++) await sleep(100);
if (!exited) child.kill('SIGKILL');
console.log('pack written to', args.out);
process.exit(0);

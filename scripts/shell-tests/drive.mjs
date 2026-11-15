// Drives one harness session for the shell permission tests (CI only).
//
//   node drive.mjs --port 3080 --fake-log <file> --cwd /root/work [--preset ask-commands]
//                  [--prompt "..."] [--approval-file <file>] [--catalog] [--wait-seconds 60]
//
// The launch token comes from the environment (DSH_TEST_TOKEN) so it never appears in a
// command line or a log. The script creates a session, optionally switches the permission
// preset with the `/permission` command, sends one prompt (the script for fake-model.mjs),
// waits until the turn is over, and prints one JSON object on stdout:
//   { catalog, presetBefore, presetAfter, sessionId, state, results: [fake-model log lines of this turn] }
// It exits 0 even when the harness refused something: the caller judges the results.
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : acc), []));
const port = args.port, token = process.env.DSH_TEST_TOKEN;
if (!port || !token) { console.error('need --port and DSH_TEST_TOKEN'); process.exit(2); }
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readLog = () => (existsSync(args['fake-log']) ? readFileSync(args['fake-log'], 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

const ex = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (ex.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
if (!cookie) { console.error('no session cookie after the token exchange'); process.exit(3); }

async function call(method, payload) {
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: payload } }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, result: body.result ?? body };
}
const val = (r) => r.result?.value ?? r.result;

const out = {};
if (args.catalog) out.catalog = val(await call('permissionPresets/catalog', {}));
const created = await call('session/create', { request: { cwd: args.cwd } });
const sessionId = val(created)?.sessionId;
if (!sessionId) { console.error('session/create failed: ' + JSON.stringify(created.result).slice(0, 300)); process.exit(4); }
out.sessionId = sessionId;
const slash = async (line) => val(await call('commands/execute', { agentId: sessionId, line, submittedAttachments: [] }));
out.presetBefore = (await slash('/permission'))?.text ?? null;
if (args.preset) {
  out.switchResult = (await slash(`/permission ${args.preset}`))?.text ?? null;
  await sleep(300);
  out.presetAfter = (await slash('/permission'))?.text ?? null;
}
const before = readLog().length;
if (args.prompt) {
  const p = await call('session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: args.prompt }] } });
  out.promptStatus = p.status;
  const deadline = Date.now() + Number(args['wait-seconds'] ?? 60) * 1000;
  // The turn is over when the model said DONE (its last request has all results) and the session is idle.
  let state = null;
  while (Date.now() < deadline) {
    const w = val(await call('session/wait', { request: { sessionId, timeoutMs: 1500 } }));
    state = w?.state ?? w?.status ?? w;
    const log = readLog().slice(before);
    const pending = JSON.stringify(state);
    if (/idle/.test(pending) && log.some((l) => l.request)) break;
    await sleep(200);
  }
  out.state = state;
}
out.results = readLog().slice(before);
console.log(JSON.stringify(out));

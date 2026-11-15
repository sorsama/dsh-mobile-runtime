// Runs scripted shell/permission scenarios against a running harness (CI only).
//
//   node scenarios.mjs --port 3080 --fake-log <file> --work /root/work --file <scenarios.json> [--out <result.json>]
//
// DSH_TEST_TOKEN (environment) is the launch token. Each scenario creates a session, selects a
// permission preset, sends one prompt made of @@CALL lines (see fake-model.mjs), answers approval
// questions through the real client protocol (answerer.mjs), waits until the expected tool results
// have arrived, and then checks what happened. Prints one PASS/FAIL line per scenario and
// one JSON summary line; exits 1 if any scenario failed.
//
// A scenario:
//   { "name": "...", "agentPreset": "minimal"?, "preset": "ask-commands"?,       how the session starts
//     "answer": "allowed-once" | "rejected" | "cancelled",                      what the approval panel does (default: fail)
//     "calls": [ {"name": "bash", "input": {...}} ],                             the script of the model
//     "expect": {
//        "presetText": "regex"?,            what `/permission` says before the script runs
//        "results": [ {"tool": "bash", "isError": false, "match": "regex"} ],   each must appear in the model's results
//        "approvals": [ {"tool": "bash", "match": "regex"} ],                   exactly these questions, in order
//        "files": { "exists": [...], "absent": [...], "lines": {"path": 1} } }  checked after the results arrived
//   }
// "@WORK@" in calls and expectations is the workspace directory.
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { startAnswerer } from './answerer.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const port = args.port, token = process.env.DSH_TEST_TOKEN, work = args.work;
if (!port || !token || !work || !args.file || !args['fake-log']) { console.error('need --port --fake-log --work --file and DSH_TEST_TOKEN'); process.exit(2); }
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readLog = () => (existsSync(args['fake-log']) ? readFileSync(args['fake-log'], 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const sub = (v) => (typeof v === 'string' ? v.replaceAll('@WORK@', work) : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [sub(k), sub(x)])) : v);

const ex = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (ex.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
if (!cookie) { console.error('no session cookie after the token exchange'); process.exit(3); }
async function call(method, payload) {
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: payload } }),
  });
  const body = await res.json().catch(() => ({}));
  return body.result ?? body;
}

let currentAnswer = null;
const answerer = await startAnswerer({ base, cookie, decide: async () => currentAnswer ?? 'rejected-unexpected' });
const spec = JSON.parse(readFileSync(args.file, 'utf8'));
const summary = { catalog: null, scenarios: [] };
if (spec.catalog) {
  const cat = (await call('permissionPresets/catalog', {})).value;
  summary.catalog = cat ? { ids: cat.options.map((o) => o.value), names: cat.options.map((o) => o.name), defaultPreset: cat.defaultPreset } : null;
  const want = spec.catalog;
  const ok = cat && JSON.stringify(summary.catalog.ids) === JSON.stringify(want.ids) && cat.defaultPreset === want.defaultPreset;
  console.log(`${ok ? 'PASS' : 'FAIL'} catalog: ${JSON.stringify(summary.catalog)}${ok ? '' : ` (wanted ${JSON.stringify(want)})`}`);
  summary.scenarios.push({ name: 'catalog', ok: Boolean(ok) });
}

const lineCount = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0);

for (const raw of spec.scenarios ?? []) {
  const sc = sub(raw);
  const problems = [];
  const mark = readLog().length;
  const approvalsBefore = answerer.requests.length;
  currentAnswer = sc.answer ?? null;
  const created = await call('session/create', { request: { cwd: work, ...(sc.agentPreset ? { agentPreset: sc.agentPreset } : {}) } });
  const sid = created.value?.sessionId;
  if (!sid) { console.log(`FAIL ${sc.name}: session/create failed: ${JSON.stringify(created).slice(0, 300)}`); summary.scenarios.push({ name: sc.name, ok: false }); continue; }
  const slash = async (line) => (await call('commands/execute', { agentId: sid, line, submittedAttachments: [] })).value?.result?.text ?? null;
  if (sc.preset) {
    const r = await slash(`/permission ${sc.preset}`);
    if (!/^preset /.test(r ?? '')) problems.push(`switching to ${sc.preset} said: ${r}`);
  }
  const presetText = await slash('/permission');
  if (sc.expect?.presetText && !new RegExp(sc.expect.presetText).test(presetText ?? '')) problems.push(`/permission said "${presetText}", wanted /${sc.expect.presetText}/`);
  const prompt = (sc.calls ?? []).map((c) => `@@CALL ${JSON.stringify(c)}`).join('\n');
  if (prompt) await call('session/prompt', { request: { requestId: randomUUID(), sessionId: sid, mode: 'queue', content: [{ type: 'text', text: prompt }] } });
  // Wait for every expected result (or give up after the timeout).
  const wants = sc.expect?.results ?? [];
  const timeoutMs = (sc.timeoutSeconds ?? 60) * 1000;
  const deadline = Date.now() + timeoutMs;
  let results = [];
  const matched = () => {
    results = readLog().slice(mark).filter((l) => l.tool !== undefined);
    const used = new Set();
    return wants.map((w) => {
      const i = results.findIndex((r, idx) => !used.has(idx) && (w.tool === undefined || r.tool === w.tool) && (w.isError === undefined || r.isError === w.isError) && (w.match === undefined || new RegExp(w.match, 's').test(r.text)));
      if (i >= 0) used.add(i);
      return i >= 0;
    });
  };
  while (Date.now() < deadline && !matched().every(Boolean)) await sleep(250);
  const got = matched();
  wants.forEach((w, i) => { if (!got[i]) problems.push(`no result like ${JSON.stringify(w)}; got ${JSON.stringify(results.map((r) => ({ tool: r.tool, isError: r.isError, text: r.text.slice(0, 160) })))}`); });
  await sleep(sc.settleMs ?? 800); // anything that would run late has had its chance
  // Exactly the expected number of tool results: nothing ran that should not have.
  if (sc.expect?.exactResults !== undefined) {
    const n = readLog().slice(mark).filter((l) => l.tool !== undefined).length;
    if (n !== sc.expect.exactResults) problems.push(`${n} tool results, wanted exactly ${sc.expect.exactResults}`);
  }
  const asked = answerer.requests.slice(approvalsBefore);
  const wantAsk = sc.expect?.approvals ?? [];
  if (asked.length !== wantAsk.length) problems.push(`${asked.length} approval question(s) ${JSON.stringify(asked.map((a) => ({ tool: a.toolName, reason: String(a.reason).slice(0, 120) })))}, wanted ${wantAsk.length}`);
  else wantAsk.forEach((w, i) => {
    const a = asked[i];
    if ((w.tool && a.toolName !== w.tool) || (w.match && !new RegExp(w.match, 's').test(`${a.reason}\n${a.display ?? ''}`))) problems.push(`approval ${i + 1} was ${JSON.stringify(a)}, wanted ${JSON.stringify(w)}`);
  });
  const f = sc.expect?.files ?? {};
  for (const p of f.exists ?? []) if (!existsSync(p)) problems.push(`missing file ${p}`);
  for (const p of f.absent ?? []) if (existsSync(p)) problems.push(`file exists but must not: ${p}`);
  for (const [p, n] of Object.entries(f.lines ?? {})) if (lineCount(p) !== n) problems.push(`${p} has ${lineCount(p)} line(s), wanted ${n}`);
  const ok = problems.length === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${sc.name}${ok ? '' : '\n   - ' + problems.join('\n   - ')}`);
  summary.scenarios.push({ name: sc.name, ok, approvals: asked.map((a) => ({ tool: a.toolName, answer: a.answer })) });
}
answerer.stop();
console.log('SUMMARY ' + JSON.stringify({ passed: summary.scenarios.filter((s) => s.ok).length, failed: summary.scenarios.filter((s) => !s.ok).length, catalog: summary.catalog }));
if (args.out) (await import('node:fs')).writeFileSync(args.out, JSON.stringify(summary, null, 2));
process.exit(summary.scenarios.every((s) => s.ok) ? 0 : 1);

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
//        "approvals": [ {"tool": "bash", "match": "regex",                      exactly these questions, in order;
//                        "fullTextOf": 0,                                        the question carries the whole text of call 0 (the command,
//                                                                                program or arguments) in `reason` and in `displayReason.en`:
//                                                                                nothing cut, nothing added
//                        "endsWith": "marker"} ],                                both fields end with this text
//        "codes": [ {"tool": "bash", "code": "APPROVAL_REJECTED_BY_USER",        a tool/result event of the session (or, with "where": "subagent",
//                    "where": "session"|"subagent"} ],                           of its subagent) has this error code, read with session/events;
//                                                                                "code": null: an error result with no data.error at all;
//                                                                                a list of codes (null included) accepts any of them
//        "files": { "exists": [...], "absent": [...], "lines": {"path": 1},
//                   "contains": {"path": "text"} } }                             checked after the results arrived
//   }
// "@WORK@" in calls and expectations is the workspace directory. "@LINES:<n>@" is n lines of shell comment
// (65 bytes each with the newline), "@JSLINES:<n>@" the same as JavaScript comments, "@E:<n>@" is n times the
// two-byte letter é. A call with "padToBytes": N has its "@PAD@" replaced by as many x as make its text exactly N bytes.
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { startAnswerer } from './answerer.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const port = args.port, token = process.env.DSH_TEST_TOKEN, work = args.work;
if (!port || !token || !work || !args.file || !args['fake-log']) { console.error('need --port --fake-log --work --file and DSH_TEST_TOKEN'); process.exit(2); }
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readLog = () => (existsSync(args['fake-log']) ? readFileSync(args['fake-log'], 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const lines = (n, mark = '#') => Array.from({ length: n }, (_, i) => `${mark} line ${String(i + 1).padStart(6, '0')} ${'x'.repeat(50)}`).join('\n');
const sub = (v) => (typeof v === 'string' ? v.replaceAll('@WORK@', work).replace(/@LINES:(\d+)@/g, (_, n) => lines(Number(n))).replace(/@JSLINES:(\d+)@/g, (_, n) => lines(Number(n), '//')).replace(/@E:(\d+)@/g, (_, n) => 'é'.repeat(Number(n))) : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [sub(k), sub(x)])) : v);

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

// Every error result of a session and of its subagents, as the client finds it: the `tool/result` events of
// `session/events`, with `data.error` = { name, code } when the harness gave the failure a code.
async function errorResults(sessionId) {
  const out = [];
  const walk = async (address, where) => {
    const events = ((await call('session/events', { request: { address } })).value?.records ?? []).map((r) => r.event);
    const names = new Map(events.filter((e) => e.type === 'tool/call').map((e) => [e.data.callId, e.data.name]));
    for (const e of events) {
      if (e.type === 'tool/result' && e.data.message?.isError) out.push({ where, tool: names.get(e.data.message.toolCallId) ?? '?', name: e.data.error?.name, code: e.data.error?.code });
      if (e.type === 'subagent/catalog' && e.data.childId) await walk({ kind: 'subagent', parentSessionId: sessionId, childSessionId: e.data.childId, mode: e.data.mode ?? 'continuable' }, 'subagent');
    }
  };
  await walk({ kind: 'session', sessionId }, 'session');
  return out;
}

const lineCount = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0);

for (const raw of spec.scenarios ?? []) {
  const sc = sub(raw);
  for (const c of sc.calls ?? []) {
    if (c.padToBytes === undefined) continue;
    const key = ['command', 'input', 'code', 'program'].find((k) => typeof c.input[k] === 'string' && c.input[k].includes('@PAD@'));
    c.input[key] = c.input[key].replace('@PAD@', 'x'.repeat(c.padToBytes - Buffer.byteLength(c.input[key].replace('@PAD@', ''), 'utf8')));
    delete c.padToBytes;
  }
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
    if ((w.tool && a.toolName !== w.tool) || (w.match && !new RegExp(w.match, 's').test(`${a.reason}\n${a.display ?? ''}`))) problems.push(`approval ${i + 1} was ${JSON.stringify({ ...a, reason: String(a.reason).slice(0, 200), display: String(a.display).slice(0, 200) })}, wanted ${JSON.stringify(w)}`);
    if (w.fullTextOf !== undefined) {
      const call = sc.calls[w.fullTextOf];
      const text = ['command', 'input', 'code', 'program', 'file_path'].map((k) => call.input[k]).find((v) => typeof v === 'string') ?? JSON.stringify(call.input);
      const bytes = (t) => Buffer.byteLength(String(t ?? ''), 'utf8');
      const shown = String(a.display ?? '');
      if (a.reason !== `${call.name}: ${text}`) problems.push(`approval ${i + 1}: reason is ${bytes(a.reason)} bytes, not the prefix and the whole text (${bytes(text)} bytes); it ends with ${JSON.stringify(String(a.reason).slice(-60))}`);
      if (!shown.endsWith(`\n${text}`) || shown.indexOf('\n') !== shown.length - text.length - 1) problems.push(`approval ${i + 1}: displayReason.en is ${bytes(shown)} bytes, not the question line and the whole text (${bytes(text)} bytes); it ends with ${JSON.stringify(shown.slice(-60))}`);
      if (w.minTextBytes !== undefined && bytes(text) < w.minTextBytes) problems.push(`the text is only ${bytes(text)} bytes, the scenario wants at least ${w.minTextBytes}`);
      console.log(`   approval ${i + 1} as the client received it: reason ${bytes(a.reason)} bytes, displayReason.en ${bytes(shown)} bytes, the text itself ${bytes(text)} bytes`);
    }
    if (w.endsWith !== undefined && !(String(a.reason).endsWith(w.endsWith) && String(a.display).endsWith(w.endsWith))) problems.push(`approval ${i + 1} does not end with ${JSON.stringify(w.endsWith)} in both fields (reason ends ${JSON.stringify(String(a.reason).slice(-40))}, displayReason.en ends ${JSON.stringify(String(a.display).slice(-40))})`);
  });
  if ((sc.expect?.codes ?? []).length > 0) {
    const errors = await errorResults(sid);
    for (const w of sc.expect.codes) {
      // "code" may be a list of alternatives, and null stands for an error result that carries no code at all
      // (data.error absent). A list is for what the harness decides (not this gate): what the client receives is printed.
      const alternatives = Array.isArray(w.code) ? w.code : [w.code];
      const hit = errors.find((e) => (w.tool === undefined || e.tool === w.tool) && alternatives.some((c) => (c === null ? e.code === undefined : e.code === c)) && (w.where === undefined || e.where === w.where));
      if (!hit) problems.push(`no tool/result error like ${JSON.stringify(w)}; the session has ${JSON.stringify(errors)}`);
      else if (hit.code === undefined) console.log(`   client finds it: tool/result with isError true and no data.error (${hit.where}, tool ${hit.tool})`);
      else if (!Array.isArray(w.code) && hit.name !== 'DshMobilePermissionDenied') problems.push(`error code ${w.code} came with the name ${JSON.stringify(hit.name)}, wanted "DshMobilePermissionDenied"`);
      else console.log(`   client finds it: tool/result data.error = { name: "${hit.name}", code: "${hit.code}" } (${hit.where}, tool ${hit.tool})`);
    }
  }
  const f = sc.expect?.files ?? {};
  for (const p of f.exists ?? []) if (!existsSync(p)) problems.push(`missing file ${p}`);
  for (const p of f.absent ?? []) if (existsSync(p)) problems.push(`file exists but must not: ${p}`);
  for (const [p, n] of Object.entries(f.lines ?? {})) if (lineCount(p) !== n) problems.push(`${p} has ${lineCount(p)} line(s), wanted ${n}`);
  for (const [p, text] of Object.entries(f.contains ?? {})) if (!existsSync(p) || !readFileSync(p, 'utf8').includes(text)) problems.push(`${p} does not contain ${JSON.stringify(text)}`);
  const ok = problems.length === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${sc.name}${ok ? '' : '\n   - ' + problems.join('\n   - ')}`);
  summary.scenarios.push({ name: sc.name, ok, approvals: asked.map((a) => ({ tool: a.toolName, answer: a.answer })) });
}
answerer.stop();
console.log('SUMMARY ' + JSON.stringify({ passed: summary.scenarios.filter((s) => s.ok).length, failed: summary.scenarios.filter((s) => !s.ok).length, catalog: summary.catalog }));
if (args.out) (await import('node:fs')).writeFileSync(args.out, JSON.stringify(summary, null, 2));
process.exit(summary.scenarios.every((s) => s.ok) ? 0 : 1);

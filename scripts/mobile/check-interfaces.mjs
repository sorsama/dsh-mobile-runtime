// Build-time check: does the Android permission patch (android.patch.yml and permission.mjs, in
// this directory) still fit the harness that was just installed? CI only; never shipped.
//
//   node check-interfaces.mjs <harness root, for example /opt/dsh>
//
// The patch leans on a handful of harness internals: the `permission`, `sandbox-policy` and
// `approval` rows of dsh-base, the preset service class and its methods, the per-call gate
// `tools/pre-execute` and the way a pending ask is resolved, and the session header that names a
// subagent's parent. A new harness version can change any of them. This script says so, by name,
// and stops the build, so a release never ships presets that silently do not work, or a gate that
// silently is not there. The smoke test then proves the behaviour itself; this check only turns the
// most likely breakages into a message that says what to fix.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) { console.error('usage: check-interfaces.mjs <harness root>'); process.exit(2); }
const nm = `${root}/node_modules/@deepseek-ai`;
const read = (rel) => (existsSync(`${nm}/${rel}`) ? readFileSync(`${nm}/${rel}`, 'utf8') : '');
const problems = [];
const need = (ok, what) => { if (!ok) problems.push(what); };

const version = JSON.parse(read('dsh/package.json') || '{}').version ?? 'unknown';

// 1. The rows the patch replaces or relies on.
const base = read('dsh-base/cordis.patch.yml');
const row = (id) => new RegExp(`- id: ${id}\\n\\s+name: '(@deepseek-ai/[a-z0-9-]+)'`).exec(base)?.[1];
need(row('permission') === '@deepseek-ai/dsh-permission-presets', 'dsh-base has no row `permission` with the plugin @deepseek-ai/dsh-permission-presets (the patch switches that row off and mounts permission.mjs in its place)');
need(row('sandbox-policy') === '@deepseek-ai/dsh-sandbox-policy', 'dsh-base has no row `sandbox-policy` (the patch relies on its default of workspace-write to stay closed)');
need(row('approval') === '@deepseek-ai/dsh-user-approval', 'dsh-base has no row `approval`');
need(/workspace-write/.test(base) && /danger-full-access/.test(base), 'dsh-base no longer mentions the modes workspace-write and danger-full-access');

// 2. The per-call gate and how an ask is answered.
const pipeline = read('dsh-tools/lib/pipeline.js');
need(pipeline.includes('"tools/pre-execute"'), 'dsh-tools no longer runs the waterfall `tools/pre-execute` before a tool call (the gate of Ask before commands)');
need(pipeline.includes('serviceAsk') && pipeline.includes('"allowed-once"'), 'dsh-tools no longer resolves an `ask` decision through the approval service with the outcome "allowed-once"');
need(/kind === "ask"/.test(pipeline) && /kind: "deny"/.test(pipeline), 'dsh-tools no longer knows the pre-execute decisions `ask` and `deny`');

// 3. The service classes the gate reads.
const load = async (rel) => import(pathToFileURL(`${nm}/${rel}`).href);
let Presets;
try {
  Presets = (await load('dsh-permission-presets/lib/index.js')).default;
  need(typeof Presets === 'function', 'dsh-permission-presets has no default export class');
  need(Array.isArray(Presets?.inject), 'the preset service class has no static `inject` list');
  for (const m of ['permissionState', 'current', 'apply', 'catalog', 'derive', 'resolve']) need(typeof Presets?.prototype?.[m] === 'function', `the preset service class has no method ${m}()`);
} catch (error) { need(false, `dsh-permission-presets cannot be imported: ${error.message}`); }
try {
  const Approval = (await load('dsh-user-approval/lib/index.js')).ApprovalService;
  need(typeof Approval?.prototype?.effectivePolicy === 'function', 'the approval service has no method effectivePolicy()');
} catch (error) { need(false, `dsh-user-approval cannot be imported: ${error.message}`); }
try {
  const Sandbox = (await load('dsh-sandbox-policy/lib/index.js')).SandboxPolicyService;
  need(typeof Sandbox?.prototype?.resolve === 'function', 'the sandbox policy service has no method resolve()');
} catch (error) { need(false, `dsh-sandbox-policy cannot be imported: ${error.message}`); }
need(/get\(id\) \{\s*return this\.store\.get\(id\)\?\.session;/.test(read('dsh-session/lib/index.js')), 'the session store no longer has get(id) that returns the live session (the gate finds the parent of a subagent with it)');
need(read('dsh-session/lib/index.js').includes('parentSession'), 'session headers no longer carry `parentSession` (the gate finds the session that started a subagent with it)');
need(read('dsh-subagent/lib/index.js').includes('"delegation"'), 'dsh-subagent no longer marks the policy it hands to a child as a delegation');

// 4. Our own module still extends the class it was written against.
const mine = `${root}/mobile/permission.mjs`;
if (!existsSync(mine)) need(false, `${mine} is not installed`);
else try {
  const Mobile = (await import(pathToFileURL(mine).href)).default;
  need(Object.getPrototypeOf(Mobile) === Presets, 'permission.mjs does not extend the harness preset service class');
  need(Mobile.inject.includes('sandboxPolicy') && Mobile.inject.includes('approval') && Mobile.inject.includes('sessions'), 'permission.mjs does not require the services it reads');
} catch (error) { need(false, `permission.mjs cannot be imported: ${error.message}`); }

if (problems.length > 0) {
  console.error(`::error title=Android permission patch does not fit @deepseek-ai/dsh ${version}::${problems.length} interface check(s) failed. The patch in scripts/mobile/ needs an update before this harness version can ship.`);
  console.error(`The Android permission patch (scripts/mobile/) does not fit @deepseek-ai/dsh ${version}:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('The build stops here on purpose: a bundle without working presets would either refuse every shell command or run commands that "Ask before commands" should have asked about.');
  process.exit(1);
}
console.log(`Android permission patch fits @deepseek-ai/dsh ${version}: rows, gate, services and session header checked`);

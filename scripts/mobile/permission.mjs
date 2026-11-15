// DSH Mobile runtime: the permission presets service of the built-in harness, with the
// "Ask before commands" gate built in. Loaded from /opt/dsh/mobile/android.patch.yml in place
// of the harness's own `permission` row. It changes no file of the harness: it extends the
// harness's own service class, so every upstream rule (preset table, `/permission`, the
// session events, `catalog`) stays exactly as upstream wrote it.
//
// Why the gate lives inside this service and not in a plugin of its own:
//   A plugin row that fails to load is only a warning in this harness ("1 entry did not
//   activate"), and the harness starts anyway. A separate gate plugin that failed to load would
//   leave "Ask before commands" running commands without asking. Here the gate and the preset
//   service are one unit: if this file cannot load, or the service cannot start, there are no
//   presets either. The patch then leaves the harness's own deployment default in place
//   (workspace-write, which refuses every command on Android), and only this service ever pins a
//   session to full access. So the failure mode is "commands refused", never "commands unasked".
//
// How the gate works: it listens on the harness's per-call gate, `tools/pre-execute`, which runs
// for every model-initiated tool call before the tool body starts (calls of subagents and calls a
// code-mode program makes included). For a gated call it returns an `ask` decision; the harness
// asks the approval service, which sends the question to the app's approval panel. Only
// `allowed-once` lets that one call run. A reject, a cancel, no answerer, or a policy of "never"
// all end in a denial, and the tool body never starts. A listener that throws does the same:
// the harness answers the call with an error and does not run it.
//
// What it gates, only on a session that is on "Ask before commands" (Full access is left alone):
//   - tools that run a command or start code: bash (also the persistent shell), run_code,
//     terminal_open, terminal_send;
//   - plugin_manager actions that change something (everything except list_*);
//   - write and edit when the file is outside the session's workspace (and outside the temp dir).
// A subagent cannot ask anyone (the harness pins its approval policy to "never"), so a gated call
// of a subagent of an "Ask before commands" session is denied, not asked.
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'

export const FULL_ACCESS = 'danger-full-access'
export const ASK_COMMANDS = 'ask-commands'

// Tools that run a command, or start code that can. Matched by the tool's name.
const SHELL_TOOLS = ['bash', 'terminal_open', 'terminal_send', 'run_code']
// File tools that change a file; the path is in `file_path`.
const WRITE_TOOLS = ['write', 'edit']
const MAX_TEXT = 2000

const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}...` : text)

function describe(exec) {
  const args = exec.arguments ?? {}
  for (const key of ['command', 'input', 'code', 'program', 'file_path']) if (typeof args[key] === 'string') return clip(args[key])
  try { return clip(JSON.stringify(args)) } catch { return '(arguments not readable)' }
}

/** The path with symbolic links resolved as far as it exists; the rest is kept as written. */
function realish(path) {
  const rest = []
  let current = path
  for (;;) {
    try { return join(realpathSync(current), ...rest.reverse()) } catch {
      const parent = dirname(current)
      if (parent === current) return path
      rest.push(basename(current))
      current = parent
    }
  }
}

const within = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

/** Whether a write or edit call targets a file outside the workspace and the temp dir. */
function writesOutside(exec, workspaceRoot) {
  const file = exec.arguments?.file_path
  if (typeof file !== 'string' || file === '') return true // unreadable: treat as outside
  const target = realish(resolve(isAbsolute(file) ? file : join(workspaceRoot, file)))
  return ![workspaceRoot, tmpdir(), '/tmp'].some((root) => within(target, realish(resolve(root))))
}

/** What kind of call this is for the gate: 'shell', 'write', or undefined for every other tool. */
function kindOf(exec) {
  if (SHELL_TOOLS.includes(exec.name)) return 'shell'
  if (exec.name === 'plugin_manager') return String(exec.arguments?.action ?? '').startsWith('list_') ? undefined : 'shell'
  if (WRITE_TOOLS.includes(exec.name)) return 'write'
  return undefined
}

function denied(exec, why) {
  return {
    kind: 'deny',
    reason: `${exec.name}: ${why}, so this session cannot ask the user for approval and the call was not run. Say so in your reply instead of retrying.`,
  }
}

export default class MobilePermissionPresetService extends PermissionPresetService {
  // The upstream requirements, plus the service the gate reads. A missing one keeps this
  // service from starting, which leaves the harness without presets (see above).
  static inject = [...PermissionPresetService.inject, 'sandboxPolicy']

  constructor(ctx, config) {
    super(ctx, config)
    ctx.on('tools/pre-execute', async (exec, next) => {
      const kind = kindOf(exec)
      if (kind === undefined) return next()
      const session = exec.agent?.session
      // No session: there is nothing to read the preset from. Asking makes the harness deny the call.
      if (session === undefined) return { kind: 'ask', reason: `${exec.name}: ${describe(exec)}` }
      const policy = this.ctx.sandboxPolicy.resolve({ session })
      // A confining sandbox mode decides for itself (and refuses to run where it cannot confine).
      if (policy.mode !== FULL_ACCESS) return next()
      // The session the user is talking to decides, not the subagent. The harness starts every
      // subagent with approval pinned to "never" and then derives its preset from that, so a
      // subagent of an "Ask before commands" session looks exactly like a Full access one.
      const owner = this.owningSession(session)
      if (owner === undefined) return denied(exec, 'the session that started this subagent is gone, so there is nobody to ask')
      const ownerPolicy = this.ctx.approval.effectivePolicy(owner)
      // Exactly the Full access bundle, chosen on that session: the user wants no questions.
      if (this.permissionState(owner).preset === FULL_ACCESS && ownerPolicy === 'never') return next()
      // Inside the workspace a file change needs no question.
      if (kind === 'write' && !writesOutside(exec, policy.workspaceRoot)) return next()
      // A subagent cannot ask anyone, so its gated calls are refused, and it is told so.
      if (owner !== session) return denied(exec, 'this is a subagent, and the session that started it asks before commands')
      if (ownerPolicy !== 'ask') return denied(exec, 'approval is switched off in this session')
      const what = describe(exec)
      return {
        kind: 'ask',
        reason: `${exec.name}: ${what}`,
        displayReason: {
          en: kind === 'write' ? `Allow a change outside the workspace?\n${what}` : exec.name === 'bash' ? `Run this command?\n${what}` : `Allow ${exec.name}?\n${what}`,
        },
      }
    })
  }

  /** The session a chain of subagents started from (the session itself when it is top level); undefined when a link is missing. */
  owningSession(session) {
    let current = session
    for (let depth = 0; depth < 64; depth++) {
      const parentId = current.header?.parentSession
      if (parentId === undefined) return current
      const parent = this.ctx.sessions.get(parentId)
      if (parent === undefined) return undefined
      current = parent
    }
    return undefined
  }
}

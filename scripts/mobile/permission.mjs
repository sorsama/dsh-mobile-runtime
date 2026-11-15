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
// code-mode program makes included). For a gated call it asks the harness's approval service, which
// sends the question to the app's approval panel. Only `allowed-once` lets that one call run. A
// reject, a cancel, no answerer, or a policy of "never" all end in a denial, and the tool body never
// starts. The gate catches its own failures and turns them into a denial too (PERMISSION_GATE_ERROR),
// so a gate that throws never lets a call run.
//
// What it gates, only on a session that is on "Ask before commands" (Full access is left alone):
//   - tools that run a command or start code: bash (also the persistent shell), run_code,
//     terminal_open, terminal_send;
//   - plugin_manager actions that change something (everything except list_*);
//   - write and edit when the file is outside the session's workspace (and outside the temp dir).
// A subagent cannot ask anyone (the harness pins its approval policy to "never"), so a gated call
// of a subagent of an "Ask before commands" session is denied, not asked.
//
// The user sees what they approve, all of it. The text of the question (the command, the program of
// `run_code`, the summary of the other arguments) is never shortened. A call whose text is larger than
// MAX_APPROVAL_BYTES is refused with the code APPROVAL_TEXT_TOO_LARGE and is not asked about, because
// asking with a cut text would let the user approve what they cannot read.
//
// Every denial of this gate carries a stable code next to its sentence. The harness puts it in the
// tool result event of the session: `tool/result` -> `data.error` = { name, code }, with
// `name` always "DshMobilePermissionDenied". The sentence in the result text is for the model and may
// change; the code is the contract. See the README ("What the app has to do").
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
/** The largest text one approval may carry, in UTF-8 bytes. Above it the call is refused, never cut. */
export const MAX_APPROVAL_BYTES = 256 * 1024

/** `error.name` of every denial of this gate; the `code` tells them apart. */
export const DENIAL_NAME = 'DshMobilePermissionDenied'

/** The codes this gate puts on a denial (`tool/result` event, `data.error.code`). */
export const CODES = Object.freeze({
  /** A subagent of an "Ask before commands" session tried a gated call; a subagent cannot ask. */
  SUBAGENT: 'APPROVAL_NOT_AVAILABLE_TO_SUBAGENT',
  /** The session that started this subagent is gone, so nobody can be asked. */
  OWNER_GONE: 'APPROVAL_OWNER_SESSION_GONE',
  /** Approval is switched off in the session, so a question cannot be asked. */
  SWITCHED_OFF: 'APPROVAL_SWITCHED_OFF',
  /** The user answered "reject". */
  REJECTED: 'APPROVAL_REJECTED_BY_USER',
  /** The question was cancelled (the client withdrew it) and the turn was not stopped. */
  CANCELLED: 'APPROVAL_CANCELLED',
  /** No client answered: no approval channel is available. */
  UNAVAILABLE: 'APPROVAL_UNAVAILABLE',
  /** The text to approve is larger than MAX_APPROVAL_BYTES; nothing was asked and nothing ran. */
  TOO_LARGE: 'APPROVAL_TEXT_TOO_LARGE',
  /** The arguments could not be turned into text to show; nothing was asked and nothing ran. */
  UNREADABLE: 'APPROVAL_TEXT_UNREADABLE',
  /** The gate itself failed (an exception), so the call was not run. */
  GATE_ERROR: 'PERMISSION_GATE_ERROR',
})

/** The complete text the user is asked to approve, or undefined when the arguments cannot be shown. */
function describe(exec) {
  const args = exec.arguments ?? {}
  for (const key of ['command', 'input', 'code', 'program', 'file_path']) if (typeof args[key] === 'string') return args[key]
  try { return JSON.stringify(args) } catch { return undefined }
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

/** A denial with its code. `message` is what the model reads; `code` is what the app matches. */
function deny(code, message) {
  return { kind: 'deny', reason: message, info: { name: DENIAL_NAME, code } }
}

/** The denial of a call that cannot ask anyone. The sentence is the one earlier releases sent. */
function denied(exec, why, code) {
  return deny(code, `${exec.name}: ${why}, so this session cannot ask the user for approval and the call was not run. Say so in your reply instead of retrying.`)
}

export default class MobilePermissionPresetService extends PermissionPresetService {
  // The upstream requirements, plus the service the gate reads. A missing one keeps this
  // service from starting, which leaves the harness without presets (see above).
  static inject = [...PermissionPresetService.inject, 'sandboxPolicy']

  constructor(ctx, config) {
    super(ctx, config)
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        return await this.gate(exec, next)
      } catch (error) {
        // A gate that fails must not let the call run. The harness would turn a thrown error into an
        // error result as well; catching it here gives that result a code.
        return deny(CODES.GATE_ERROR, `${exec.name}: the permission check failed (${error instanceof Error ? error.message : String(error)}), so the call was not run.`)
      }
    })
  }

  /** The decision of the gate for one tool call: allow (next), deny with a code, or the user's answer. */
  async gate(exec, next) {
    const kind = kindOf(exec)
    if (kind === undefined) return next()
    const session = exec.agent?.session
    // No session: there is nothing to read the preset from, and nobody to ask.
    if (session === undefined) return deny(CODES.UNAVAILABLE, `tool "${exec.name}" requires approval, but the call has no agent to route it through`)
    const policy = this.ctx.sandboxPolicy.resolve({ session })
    // A confining sandbox mode decides for itself (and refuses to run where it cannot confine).
    if (policy.mode !== FULL_ACCESS) return next()
    // The session the user is talking to decides, not the subagent. The harness starts every
    // subagent with approval pinned to "never" and then derives its preset from that, so a
    // subagent of an "Ask before commands" session looks exactly like a Full access one.
    const owner = this.owningSession(session)
    if (owner === undefined) return denied(exec, 'the session that started this subagent is gone, so there is nobody to ask', CODES.OWNER_GONE)
    const ownerPolicy = this.ctx.approval.effectivePolicy(owner)
    // Exactly the Full access bundle, chosen on that session: the user wants no questions.
    if (this.permissionState(owner).preset === FULL_ACCESS && ownerPolicy === 'never') return next()
    // Inside the workspace a file change needs no question.
    if (kind === 'write' && !writesOutside(exec, policy.workspaceRoot)) return next()
    // A subagent cannot ask anyone, so its gated calls are refused, and it is told so.
    if (owner !== session) return denied(exec, 'this is a subagent, and the session that started it asks before commands', CODES.SUBAGENT)
    if (ownerPolicy !== 'ask') return denied(exec, 'approval is switched off in this session', CODES.SWITCHED_OFF)
    // The user is asked with the whole text, or not at all.
    const what = describe(exec)
    if (what === undefined) return deny(CODES.UNREADABLE, `${exec.name}: the arguments of this call cannot be shown to the user, so the call was not asked about and was not run.`)
    const bytes = Buffer.byteLength(what, 'utf8')
    if (bytes > MAX_APPROVAL_BYTES) {
      return deny(CODES.TOO_LARGE, `${exec.name}: the text to approve is ${bytes} bytes, over the limit of ${MAX_APPROVAL_BYTES} bytes for one approval. The user cannot be asked about text that is cut, so the call was not asked about and was not run. Run it in smaller parts.`)
    }
    // The question is asked here, and not by returning an `ask` decision, so that every way it can end
    // has its own code. This is what the harness does with an `ask` (tools/pipeline.js, serviceAsk):
    // the same request, the same mapping of the four answers.
    const outcome = await this.ctx.approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      reason: `${exec.name}: ${what}`,
      displayReason: {
        en: kind === 'write' ? `Allow a change outside the workspace?\n${what}` : exec.name === 'bash' ? `Run this command?\n${what}` : `Allow ${exec.name}?\n${what}`,
      },
      signal: exec.signal,
    })
    switch (outcome) {
      case 'allowed-once': return { kind: 'allow' }
      case 'rejected': return deny(CODES.REJECTED, `the user rejected tool "${exec.name}"`)
      // The turn was stopped while the question was open: the harness's own "aborted" result, as before.
      case 'cancelled': return exec.signal?.aborted ? { kind: 'cancel' } : deny(CODES.CANCELLED, `approval for tool "${exec.name}" was cancelled`)
      default: return deny(CODES.UNAVAILABLE, `tool "${exec.name}" requires approval, but no approval channel is available`)
    }
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

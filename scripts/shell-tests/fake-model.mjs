// A scripted fake model endpoint (Anthropic Messages API, streamed), for CI only.
// It lets the smoke test make the real harness call real tools without a real model or key.
//
//   node fake-model.mjs <log-file> <port>
//
// The first user message of a conversation carries the script: one or more lines
//   @@CALL {"name": "bash", "input": {"command": "echo hi"}}
// The model asks for those tool calls one after the other (the next one only after the
// harness answered the previous one) and ends the turn with the text "DONE".
// A conversation without @@CALL lines just answers "OK." (this is what the session title
// request gets). A subagent's task is the first user message of its own conversation, so the
// script of a subagent is whatever the parent puts into the `prompt` of its `subagent` call.
//
// Every tool result the harness hands back is logged as one JSON line:
//   {"n": <number of the call in its conversation>, "tool": "bash", "isError": false, "text": "..."}
// and every model request as {"request": {"tools": [...names]}}. No request body is logged.
import http from 'node:http';
import { appendFileSync } from 'node:fs';

const LOG = process.argv[2];
const PORT = Number(process.argv[3] ?? 8766);
if (!LOG) { console.error('usage: fake-model.mjs <log-file> <port>'); process.exit(2); }
const log = (obj) => appendFileSync(LOG, JSON.stringify(obj) + '\n');
const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const textOf = (content) => Array.isArray(content)
  ? content.map((c) => c.text ?? (Array.isArray(c.content) ? textOf(c.content) : (typeof c.content === 'string' ? c.content : ''))).join('')
  : String(content ?? '');

let counter = 0;
const seen = new Set();

// The script of a conversation: the JSON object after each "@@CALL ". The harness may add text
// after it (a subagent's task is followed by instructions), so the object is cut out by
// counting braces, and the text after it is ignored.
function parseScript(task) {
  const calls = [];
  let from = 0;
  for (;;) {
    const at = task.indexOf('@@CALL ', from);
    if (at < 0) break;
    const start = at + '@@CALL '.length;
    from = start;
    if (task[start] !== '{') continue;
    let depth = 0, inString = false;
    for (let i = start; i < task.length; i++) {
      const c = task[i];
      if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue; }
      if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { calls.push(JSON.parse(task.slice(start, i + 1))); } catch { /* not a call */ }
        from = i + 1;
        break;
      }
    }
  }
  return calls;
}

function stream(res, blocks, stop) {
  counter += 1;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  sse(res, 'message_start', { type: 'message_start', message: { id: `msg_${counter}`, type: 'message', role: 'assistant', model: 'deepseek-v4-flash', content: [], usage: { input_tokens: 100, output_tokens: 1 } } });
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
  });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/messages')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'no such route' } }));
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* keep empty */ }
    const tools = parsed.tools ?? [];
    const messages = parsed.messages ?? [];
    const firstUser = messages.find((m) => m.role === 'user');
    const task = textOf(firstUser?.content);
    const script = parseScript(task);
    // Tool results of this conversation, in order. The first one answers call number 1.
    const useById = new Map();
    for (const msg of messages) for (const b of Array.isArray(msg.content) ? msg.content : []) if (b.type === 'tool_use') useById.set(b.id, b.name);
    const results = [];
    for (const msg of messages) for (const b of Array.isArray(msg.content) ? msg.content : []) if (b.type === 'tool_result') results.push(b);
    if (script.length > 0) log({ request: { tools: tools.map((t) => t.name).sort(), results: results.length } });
    // Diagnosis only: FAKE_DUMP_TOOLS=<file> writes the tool definitions of the first request.
    if (process.env.FAKE_DUMP_TOOLS && !seen.has('dump')) { seen.add('dump'); appendFileSync(process.env.FAKE_DUMP_TOOLS, JSON.stringify(tools, null, 1)); }
    results.forEach((r, i) => {
      if (seen.has(r.tool_use_id)) return;
      seen.add(r.tool_use_id);
      log({ n: i + 1, tool: useById.get(r.tool_use_id) ?? '?', isError: r.is_error === true, text: textOf(r.content).replace(/\s+/g, ' ').slice(0, 1200) });
    });
    if (script.length === 0) { if (process.env.FAKE_DEBUG) log({ unscripted: task.slice(0, 400), roles: messages.map((m) => m.role).join(',') }); return stream(res, [{ type: 'text', text: 'OK.' }], 'end_turn'); }
    const next = script[results.length];
    if (!next) return stream(res, [{ type: 'text', text: 'DONE' }], 'end_turn');
    stream(res, [{ type: 'tool_use', id: `toolu_${counter + 1}_${results.length}`, name: next.name, input: next.input ?? {} }], 'tool_use');
  });
}).listen(PORT, '127.0.0.1', () => log({ listening: PORT }));

// A stand-in for the app's approval panel, speaking the harness's real client protocol (CI only).
//
// The harness sends an approval question to every connected client over one WebSocket
// (/api/remote.mux, logical stream "$events") and takes the answer from an HTTP call
// (/api/$events/result). That is what the app does. This module does the same, so the shell tests
// exercise the real route from the tool call to the answer, not a test hook inside the harness.
//
// startAnswerer({ base, cookie, decide }) -> { requests, stop() }
//   decide(request) returns 'allowed-once', 'rejected' or 'cancelled', or 'ignore' to leave the
//   question open. `requests` collects what was asked: { event, toolName, reason, display }.
import { randomUUID } from 'node:crypto';

export async function startAnswerer({ base, cookie, decide }) {
  const requests = [];
  const wsUrl = base.replace(/^http/, 'ws') + '/api/remote.mux';
  const ws = new WebSocket(wsUrl, { headers: { cookie } });
  const streamId = randomUUID();
  let clientId = null;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the approval stream did not become ready')), 20000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } })));
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('websocket error: ' + (e.message ?? 'unknown'))); });
    ws.addEventListener('message', async (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.streamId !== streamId) return;
      if (msg.type === 'error') { clearTimeout(timer); reject(new Error('stream error: ' + JSON.stringify(msg.error))); return; }
      if (msg.type !== 'item') return;
      const value = msg.value;
      if (value?.type === 'ready') { clientId = value.clientId; clearTimeout(timer); resolve(); return; }
      if (value?.type !== 'waterfall' || value.event !== 'approval/request') return;
      const request = value.request ?? {};
      const entry = { event: value.event, toolName: request.toolName, reason: request.reason ?? null, display: request.displayReason?.en ?? null };
      requests.push(entry);
      const answer = await decide(entry);
      entry.answer = answer;
      if (answer === 'ignore') return;
      const outcome = { kind: 'result', value: answer };
      await fetch(`${base}/api/$events/result`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: '$events/result', payload: { args: { clientId, eventId: value.eventId, outcome } } }),
      });
    });
  });
  await ready;
  return { requests, stop: () => { try { ws.close(); } catch { /* already closed */ } } };
}

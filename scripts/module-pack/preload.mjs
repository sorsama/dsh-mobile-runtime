// DSH runtime module pack: the --import entry point (see replay.mjs for what it does).
// This file never throws and never writes to stdout, so the harness always starts, with or
// without the pack. The real work is in replay.mjs; if even loading that fails, we carry on.
import { isMainThread } from 'node:worker_threads';

try {
  const flag = process.env.DSH_RUNTIME_MODULE_PACK;
  const disabled = flag !== undefined && /^(0|off|false|no)$/i.test(flag.trim());
  // Only the main thread of the main process: worker threads and forked children run normally.
  if (!disabled && isMainThread && typeof process.send !== 'function') {
    await import('./replay.mjs');
  }
} catch (err) {
  try { process.stderr.write('dsh module pack: off: preload failed (' + ((err && err.message) || err) + ')\n'); } catch { /* stderr may be closed */ }
}

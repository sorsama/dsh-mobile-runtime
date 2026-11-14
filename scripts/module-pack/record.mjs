// Module pack RECORDER entry point: node --import record.mjs ... (CI only, never shipped).
// Records in the main thread of the main process only, like the replay does.
import { isMainThread } from 'node:worker_threads';

if (isMainThread && typeof process.send !== 'function') await import('./record-main.mjs');

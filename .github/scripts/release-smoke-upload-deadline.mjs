// Applied only to the pinned qualified-upload Node action, never globally.
import { Worker } from 'node:worker_threads';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readPhase } from './release-smoke-phase.mjs';

const phase = readPhase();
// This upload needs no executable children. Refuse one rather than leave an
// unowned executable running after the upload process reaches its deadline.
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => { throw new Error('release upload cannot launch executable children'); };
}
syncBuiltinESMExports();
const ready = new Int32Array(new SharedArrayBuffer(4));
const worker = new Worker(`
  const { workerData } = require('node:worker_threads');
  const ready = new Int32Array(workerData.ready);
  const remaining = workerData.deadline - Date.now();
  if (remaining <= 0) process.kill(process.pid, 'SIGKILL');
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), Math.max(1, remaining));
  Atomics.store(ready, 0, 1); Atomics.notify(ready, 0);
`, { eval: true, execArgv: [], workerData: { deadline: phase.deadline, ready: ready.buffer } });
if (Atomics.wait(ready, 0, 0, 5000) === 'timed-out' || Atomics.load(ready, 0) !== 1) {
  throw new Error('release upload deadline was not armed');
}
worker.unref();

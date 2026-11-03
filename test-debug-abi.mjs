import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const d = mkdtempSync(join(tmpdir(), 'test-abi-'));
console.log('root:', d);
console.log('node version:', process.version);

// Use vitest to run the test
const { appendBusInbox, listBusInboxAfter } = await import('./src/core/fleet/bus-inbox.js');

const busDir = join(d, 'bus-inbox');
mkdirSync(busDir, { recursive: true, mode: 0o700 });

const m1 = { id: 'm-1', from: 'apps-watch', to: 'leaders', priority: 'P2', ttl: 86400000, body: { kind: 'apps-watch.observation.v1', invocationId: 'inv-1', cycle: 1, healthy: true, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0, observedState: [{ app: 'Phantom', observedRunning: true }] } };
const m2 = { id: 'm-2', from: 'apps-watch', to: 'leaders', priority: 'P2', ttl: 86400000, body: { kind: 'apps-watch.summary.v1', invocationId: 'inv-1', apps: ['Phantom'], outcome: 'completed', cycles: 1, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0, lastObservedState: [{ app: 'Phantom', observedRunning: true }] } };
const m3 = { id: 'm-3', from: 'other', to: 'leaders', priority: 'P2', ttl: 86400000, body: { foo: 'bar' } };

const r1 = appendBusInbox(m1, { root: d, now: () => 0 });
console.log('m1:', r1.status, r1.status === 'posted' ? r1.cursor : '');
const r2 = appendBusInbox(m2, { root: d, now: () => 100 });
console.log('m2:', r2.status, r2.status === 'posted' ? r2.cursor : '');
const r3 = appendBusInbox(m3, { root: d, now: () => 200 });
console.log('m3:', r3.status, r3.status === 'posted' ? r3.cursor : '');

const file = join(busDir, 'messages.json');
try {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  console.log('file rows:', data.rows?.length);
  console.log('file version:', data.version);
} catch(e) { console.log('file error:', e.message); }

// Now try reading through listBusInboxAfter
console.log('---');
const page = listBusInboxAfter(0, 100, { root: d, now: () => 300 });
console.log('listBusInboxAfter status:', page.status);
if (page.status === 'ok') {
  console.log('messages count:', page.messages.length);
  console.log('nextCursor:', page.nextCursor);
  for (const msg of page.messages) {
    console.log('  msg id:', msg.envelope.id, 'from:', msg.envelope.from, 'cursor:', msg.cursor);
  }
}

rmSync(d, { recursive: true, force: true });

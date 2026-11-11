import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cmdFleetEmailOutboxBatchAwait } from '../src/cli/fleet-email-outbox-batch-await.js';
import { writeEmailDropConfig } from '../src/core/comms/email-drop-config.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'receipt-101-')); roots.push(root);
  const outbox = join(root, 'outbox'); mkdirSync(outbox);
  await writeEmailDropConfig(root, { v: 1, inboxDir: join(root, 'inbox'), outboxDir: outbox, from: ['fake@example.test'] });
  const signals = new EventEmitter();
  const lines: string[] = [];
  const stdin = (names: string[]) => (async function* () { yield JSON.stringify(names); })();
  return { root, outbox, signals, lines, stdin };
}
const args = ['--stdin', '--timeout-ms', '300', '--poll-ms', '100', '--json'];

it('times out missing disk entries while preserving completed and ambiguous receipts', async () => {
  const f = await fixture();
  for (const state of ['sent', 'drafted']) mkdirSync(join(f.outbox, state));
  const message = 'To: fake@example.test\nSubject: fake\n\nfake';
  for (const [state, name] of [['sent', 'sent.reply.eml'], ['drafted', 'draft.reply.eml'], ['sent', 'duplicate.reply.eml'], ['drafted', 'duplicate.reply.eml']]) {
    writeFileSync(join(f.outbox, state!, name!), message);
  }
  let now = 0;
  const code = await cmdFleetEmailOutboxBatchAwait(args, { runsDir: f.root, stdin: f.stdin(['sent.reply.eml', 'draft.reply.eml', 'duplicate.reply.eml', 'missing.reply.eml']), stdout: s => f.lines.push(s), signals: f.signals, now: () => now, sleep: async ms => { now += ms; } });
  expect(code).toBe(1);
  expect(JSON.parse(f.lines[0]!)).toMatchObject({ timedOut: true, rows: [
    { name: 'sent.reply.eml', state: 'sent' }, { name: 'draft.reply.eml', state: 'drafted' },
    { name: 'duplicate.reply.eml', state: 'stuck' }, { name: 'missing.reply.eml', state: 'missing' },
  ] });
});

it('removes signal listeners after interruption during a wait', async () => {
  const f = await fixture();
  const code = await cmdFleetEmailOutboxBatchAwait(args, { runsDir: f.root, stdin: f.stdin(['missing.reply.eml']), stdout: s => f.lines.push(s), signals: f.signals, sleep: async () => { f.signals.emit('SIGINT'); } });
  expect(code).toBe(130);
  expect(JSON.parse(f.lines[0]!)).toMatchObject({ cancelled: true });
  expect(f.signals.listenerCount('SIGINT')).toBe(0);
  expect(f.signals.listenerCount('SIGTERM')).toBe(0);
});

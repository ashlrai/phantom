import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetEmailOutboxBatchAwait } from '../src/cli/fleet-email-outbox-batch-await.js';
import { writeEmailDropConfig } from '../src/core/comms/email-drop-config.js';

const roots: string[] = [];
const names = ['a.reply.eml', 'b.reply.eml'];
const message = 'To: fake@example.test\nSubject: private-subject\n\nprivate-body';
const args = ['--stdin', '--timeout-ms', '300', '--poll-ms', '100', '--json'];
async function fixture(): Promise<{ root: string; outbox: string }> {
  const root = mkdtempSync(join(tmpdir(), 'batch-await-')); roots.push(root);
  const outbox = join(root, 'outbox'); mkdirSync(outbox);
  await writeEmailDropConfig(root, { v: 1, inboxDir: join(root, 'inbox'), outboxDir: outbox, from: ['fake@example.test'] });
  return { root, outbox };
}
function input(value: string): AsyncIterable<string> { return (async function* () { yield value; })(); }
function harness(root: string, value = JSON.stringify(names)) {
  const lines: string[] = [];
  return { lines, deps: { runsDir: root, stdin: input(value), stdout: (s: string) => lines.push(s), stderr: () => {}, signals: new EventEmitter() as unknown as NodeJS.Process } };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('waits for staggered sent and drafted artifacts in input order without exposing content', async () => {
  const { root, outbox } = await fixture();
  for (const state of ['sent', 'drafted']) mkdirSync(join(outbox, state));
  for (const name of names) writeFileSync(join(outbox, name), message);
  const h = harness(root); let now = 0;
  const code = await cmdFleetEmailOutboxBatchAwait(args, { ...h.deps, now: () => now, sleep: async (ms) => {
    now += ms;
    if (now === 100) renameSync(join(outbox, names[0]!), join(outbox, 'sent', names[0]!));
    if (now === 200) renameSync(join(outbox, names[1]!), join(outbox, 'drafted', names[1]!));
  } });
  expect(code).toBe(0);
  expect(JSON.parse(h.lines[0]!).rows).toEqual([{ name: names[0], state: 'sent' }, { name: names[1], state: 'drafted' }]);
  expect(h.lines[0]).not.toMatch(/fake@|private-|outbox\//);
});

it('uses one read per poll and times out with missing evidence', async () => {
  const { root } = await fixture(); const h = harness(root, JSON.stringify(Array.from({ length: 50 }, (_, i) => `${i}.reply.eml`)));
  let now = 0; const read = vi.fn(() => ({ dir: '', counts: { queued: 0, sent: 0, drafted: 0, stuck: 0 }, entries: [] }));
  expect(await cmdFleetEmailOutboxBatchAwait(args, { ...h.deps, read, now: () => now, sleep: async (ms) => { now += ms; } })).toBe(1);
  expect(read).toHaveBeenCalledTimes(4);
  expect(JSON.parse(h.lines[0]!).rows.every((row: { state: string }) => row.state === 'missing')).toBe(true);
  expect(JSON.parse(h.lines[0]!).timedOut).toBe(true);
});

it('reports stuck and conflicting artifacts, source failure, and cancellation', async () => {
  const { root, outbox } = await fixture();
  mkdirSync(join(outbox, 'sending')); mkdirSync(join(outbox, 'sent'));
  writeFileSync(join(outbox, 'sending', names[0]!), message);
  writeFileSync(join(outbox, names[1]!), message); writeFileSync(join(outbox, 'sent', names[1]!), message);
  let h = harness(root); expect(await cmdFleetEmailOutboxBatchAwait(args, h.deps)).toBe(1);
  expect(JSON.parse(h.lines[0]!).rows.map((row: { reason: string }) => row.reason)).toEqual(['interrupted-send', 'malformed']);
  rmSync(outbox, { recursive: true }); h = harness(root);
  expect(await cmdFleetEmailOutboxBatchAwait(args, h.deps)).toBe(1);
  expect(JSON.parse(h.lines[0]!).sourceFailure).toBe(true);
  const controller = new AbortController(); h = harness(root); controller.abort();
  expect(await cmdFleetEmailOutboxBatchAwait(args, { ...h.deps, signal: controller.signal })).toBe(130);
  expect(JSON.parse(h.lines[0]!).cancelled).toBe(true);
});

it('rejects invalid stdin and options before polling', async () => {
  const { root } = await fixture(); const read = vi.fn();
  for (const value of ['{}', '[]', '[', JSON.stringify([names[0], names[0]]), JSON.stringify(['../x.reply.eml']), JSON.stringify(['a\\b.reply.eml']), JSON.stringify(Array(51).fill('a.reply.eml')), ' '.repeat(16385)]) {
    const h = harness(root, value);
    expect(await cmdFleetEmailOutboxBatchAwait(args, { ...h.deps, read })).toBe(2);
  }
  const h = harness(root);
  expect(await cmdFleetEmailOutboxBatchAwait([...args, '--dir', '/tmp'], { ...h.deps, read })).toBe(2);
  expect(read).not.toHaveBeenCalled();
});

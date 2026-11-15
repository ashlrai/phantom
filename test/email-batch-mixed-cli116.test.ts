import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cmdFleetEmailOutboxBatchAwait } from '../src/cli/fleet-email-outbox-batch-await.js';
import { writeEmailDropConfig } from '../src/core/comms/email-drop-config.js';

const roots: string[] = [];
const message = 'To: fictional@example.test\nSubject: fixture-subject-116\n\nfixture-body-116\n';
const args = ['--stdin', '--timeout-ms', '200', '--poll-ms', '100', '--json'];
const unrelated = 'unrelated-116.reply.eml';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'email-mixed-116-'));
  roots.push(root);
  const outbox = join(root, 'outbox');
  for (const dir of ['', 'drafted', 'sent', 'sending']) mkdirSync(join(outbox, dir), { recursive: true });
  await writeEmailDropConfig(root, { v: 1, inboxDir: join(root, 'inbox'), outboxDir: outbox, from: ['fictional@example.test'] });
  writeFileSync(join(outbox, unrelated), message);
  return { root, outbox };
}

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(dir: string, prefix = ''): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = join(prefix, entry.name);
      if (entry.isDirectory()) visit(join(dir, entry.name), name);
      else result[name] = readFileSync(join(dir, entry.name), 'utf8');
    }
  }
  visit(root);
  return result;
}

async function run(root: string, names: string[]) {
  const stdout: string[] = []; const stderr: string[] = [];
  const before = snapshot(root);
  let clock = 0; let sleeps = 0;
  const code = await cmdFleetEmailOutboxBatchAwait(args, {
    runsDir: root,
    stdin: (async function* () { yield JSON.stringify(names); })(),
    stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
    signals: new EventEmitter() as unknown as NodeJS.Process,
    now: () => clock,
    sleep: async (ms) => { sleeps++; clock += ms; },
  });
  expect(snapshot(root)).toEqual(before);
  expect(stderr).toEqual([]);
  expect(stdout).toHaveLength(1);
  expect(stdout[0]).not.toMatch(/fictional@example\.test|fixture-subject-116|fixture-body-116|unrelated-116/);
  return { code, result: JSON.parse(stdout[0]!) as unknown, sleeps, clock };
}

it('preserves drafted and sent as distinct terminal outcomes in input order', async () => {
  const { root, outbox } = await fixture();
  writeFileSync(join(outbox, 'drafted', 'draft.reply.eml'), message);
  writeFileSync(join(outbox, 'sent', 'sent.reply.eml'), message);
  const actual = await run(root, ['draft.reply.eml', 'sent.reply.eml']);
  expect(actual.code).toBe(0);
  expect(actual.result).toEqual({ rows: [
    { name: 'draft.reply.eml', state: 'drafted' },
    { name: 'sent.reply.eml', state: 'sent' },
  ], timedOut: false, cancelled: false, sourceFailure: false });
  expect(actual.sleeps).toBe(0);
});

it('preserves a terminal row alongside a genuinely interrupted send', async () => {
  const { root, outbox } = await fixture();
  writeFileSync(join(outbox, 'sending', 'stuck.reply.eml'), message);
  writeFileSync(join(outbox, 'drafted', 'draft.reply.eml'), message);
  const actual = await run(root, ['stuck.reply.eml', 'draft.reply.eml']);
  expect(actual.code).toBe(1);
  expect(actual.result).toEqual({ rows: [
    { name: 'stuck.reply.eml', state: 'stuck', reason: 'interrupted-send' },
    { name: 'draft.reply.eml', state: 'drafted' },
  ], timedOut: false, cancelled: false, sourceFailure: false });
  expect(actual.sleeps).toBe(0);
});

it('times out with the terminal and missing rows intact', async () => {
  const { root, outbox } = await fixture();
  writeFileSync(join(outbox, 'sent', 'sent.reply.eml'), message);
  const actual = await run(root, ['sent.reply.eml', 'missing.reply.eml']);
  expect(actual.code).toBe(1);
  expect(actual.result).toEqual({ rows: [
    { name: 'sent.reply.eml', state: 'sent' },
    { name: 'missing.reply.eml', state: 'missing' },
  ], timedOut: true, cancelled: false, sourceFailure: false });
  expect(actual.sleeps).toBe(2);
  expect(actual.clock).toBe(200);
});

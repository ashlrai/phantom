import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdAsks } from '../src/cli/asks.js';
import { emptyOwnerSettings } from '../src/core/comms/owner-channel.js';
import { answerAsk, listAsks, parseAskReply, raiseAsk, type AsksOptions } from '../src/core/fleet/asks.js';
import { answerOwnerAsk, listAskBatch } from '../src/core/fleet/asks-batch.js';
import { ASKS_LEDGER_FILE, readAskLedger, readMasonUsage } from '../src/core/fleet/asks-ledger.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const NOW = Date.parse('2026-11-19T10:00:00.000Z');
let home = '';
let opts: Required<Pick<AsksOptions, 'runsDir' | 'bus' | 'now'>>;
const ledgerPath = () => join(opts.runsDir, ASKS_LEDGER_FILE);
const events = () => {
  const page = listBusInboxAfter(0, 100, opts.bus);
  return page.status === 'ok' ? page.messages.map(m => m.envelope.body as Record<string, unknown>) : [];
};
const settings = { ...emptyOwnerSettings(), owners: { telegram: 'owner-one' } };
const owner = { channel: 'telegram' as const, senderId: 'owner-one' };
const stranger = { channel: 'telegram' as const, senderId: 'stranger' };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'example-usage-'));
  mkdirSync(join(home, 'runs'));
  opts = { runsDir: join(home, 'runs'), bus: { root: join(home, 'fleet'), now: () => NOW }, now: () => NOW };
  writeFileSync(join(opts.runsDir, 'NEEDS-MASON.md'), '# Needs Mason\n');
  expect(raiseAsk('usage', 'What percent of your Grok plan is used?', opts,
    { subject: 'grok-ultra', unblocks: 'The Cursor and Grok lanes can launch again.' })).toMatchObject({ ok: true });
  expect(raiseAsk('approval', 'Use the $112 Claude API credit before Nov 24?', opts,
    { subject: 'claude-api-credit', unblocks: 'The claude-api lane may use the credit.' })).toMatchObject({ ok: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const idOf = (kind: string) => listAsks(opts).asks.find(ask => ask.kind === kind)!.id;

describe('asks list carries question, replies, what it unblocks and age', () => {
  it('has the documented fields and a schema id', () => {
    const list = listAsks(opts);
    expect(list.schema).toBe('asks.v1');
    const usage = list.asks.find(ask => ask.kind === 'usage')!;
    expect(usage).toMatchObject({
      request: 'What percent of your Grok plan is used?', replies: [], replyHint: 'a number from 0 to 100',
      unblocks: 'The Cursor and Grok lanes can launch again.', subject: 'grok-ultra', ageSeconds: 0,
    });
    expect(list.asks.find(ask => ask.kind === 'approval')).toMatchObject({ replies: ['yes', 'no'], subject: 'claude-api-credit' });
  });

  it('shows the batch with a short-value box for usage and yes/no for the approval', () => {
    const batch = listAskBatch(opts, listAsks, true);
    expect(batch.asks.map(ask => [ask.kind, ask.choices])).toEqual([['short-value', []], ['yes-no', ['yes', 'no']]]);
    expect(batch.asks[0]!.whatHappens).toBe('The Cursor and Grok lanes can launch again.');
  });

  it('refuses a usage ask with no known pool', () => {
    expect(raiseAsk('usage', 'How much?', opts)).toMatchObject({ ok: false });
    expect(raiseAsk('usage', 'How much?', opts, { subject: 'nowhere' })).toMatchObject({ ok: false });
  });
});

describe('verified answer', () => {
  it('stores "40" as a usage reading with source=mason, a timestamp and a bus event', async () => {
    const outcome = await answerAsk(idOf('usage'), '40', 'cli', opts);
    expect(outcome).toMatchObject({ status: 'answered', answer: '40', answeredAt: '2026-11-19T10:00:00.000Z' });
    expect(readAskLedger(opts.runsDir)).toEqual([expect.objectContaining({
      schema: 'asks.ledger.v1', type: 'usage-reading', pool: 'grok-ultra', pctUsed: 40, source: 'mason', channel: 'cli', at: '2026-11-19T10:00:00.000Z',
    })]);
    expect(readMasonUsage('grok-ultra', { runsDir: opts.runsDir, now: () => NOW + 3_600_000 })).toMatchObject({
      pctUsed: 40, source: 'mason', fetchedAt: '2026-11-19T10:00:00.000Z', ageMs: 3_600_000,
    });
    expect(events()).toEqual([expect.objectContaining({ kind: 'needs_mason.resolved', source: 'cli', reply: '40' })]);
  });

  it('stores an approval as a record only, with the decision and no other effect', async () => {
    const outcome = await answerAsk(idOf('approval'), 'yes', 'phone', opts);
    expect(outcome.status).toBe('answered');
    expect(readAskLedger(opts.runsDir)).toEqual([expect.objectContaining({
      type: 'approval', decision: 'yes', subject: 'claude-api-credit', channel: 'phone', source: 'mason',
    })]);
    expect(readMasonUsage('grok-ultra', { runsDir: opts.runsDir })).toBeNull();
  });

  it('is append-only and answers once: a repeat adds no line and keeps the first reading', async () => {
    const id = idOf('usage');
    await answerAsk(id, '40%', 'cli', opts);
    const before = readFileSync(ledgerPath(), 'utf8');
    expect(await answerAsk(id, '55', 'cli', opts)).toMatchObject({ status: 'already-answered', answer: '40' });
    expect(readFileSync(ledgerPath(), 'utf8')).toBe(before);
    expect(readMasonUsage('grok-ultra', { runsDir: opts.runsDir })!.pctUsed).toBe(40);
  });

  it('goes through a verified owner on a channel and names that channel in the ledger', async () => {
    const outcome = await answerOwnerAsk({ askId: idOf('usage'), answer: '12.5', sender: owner }, { settings, options: opts });
    expect(outcome).toMatchObject({ status: 'answered', answer: '12.5' });
    expect(readAskLedger(opts.runsDir)[0]).toMatchObject({ pctUsed: 12.5, channel: 'telegram', source: 'mason' });
  });

  it('reads one-word channel replies with a percent: "40 <id>"', () => {
    expect(parseAskReply('40 3f2a')).toEqual({ id: '3f2a', answer: '40' });
    expect(parseAskReply('3f2a 40%')).toEqual({ id: '3f2a', answer: '40%' });
  });
});

describe('unverified sender', () => {
  it('is rejected and nothing is recorded', async () => {
    const outcome = await answerOwnerAsk({ askId: idOf('usage'), answer: '40', sender: stranger }, { settings, options: opts });
    expect(outcome).toMatchObject({ status: 'refused', message: 'Only the owner can answer. Nothing was recorded.' });
    expect(readAskLedger(opts.runsDir)).toEqual([]);
    expect(events()).toEqual([]);
    expect(listAsks(opts).count).toBe(2);
  });
});

describe('invalid reply', () => {
  it('rejects "forty" for a percent with a plain hint and records nothing', async () => {
    const outcome = await answerAsk(idOf('usage'), 'forty', 'cli', opts);
    expect(outcome).toMatchObject({ status: 'invalid', reason: 'Reply with a number from 0 to 100, like 40.' });
    for (const bad of ['101', '-5', '4 0', '']) expect((await answerAsk(idOf('usage'), bad, 'cli', opts)).status).toBe('invalid');
    expect(readAskLedger(opts.runsDir)).toEqual([]);
    expect(events()).toEqual([]);
  });

  it('rejects a usage-style number for an approval, and "maybe" for it too', async () => {
    expect(await answerAsk(idOf('approval'), '40', 'cli', opts)).toMatchObject({ status: 'invalid', reason: 'Answer yes or no.' });
    expect(readAskLedger(opts.runsDir)).toEqual([]);
  });

  it('the same hint reaches an owner on a channel', async () => {
    const outcome = await answerOwnerAsk({ askId: idOf('usage'), answer: 'forty', sender: owner }, { settings, options: opts });
    expect(outcome).toMatchObject({ status: 'invalid', message: 'Reply with a number from 0 to 100, like 40.' });
    expect(readAskLedger(opts.runsDir)).toEqual([]);
  });
});

describe('phm asks CLI', () => {
  it('answers, and reads the reading back as asks.usage.v1', async () => {
    const lines: string[] = [];
    const log = console.log; console.log = (line: string) => { lines.push(line); };
    try {
      expect(await cmdAsks(['answer', idOf('usage'), '40', '--json'], { options: opts })).toBe(0);
      expect(await cmdAsks(['answer', idOf('approval'), 'forty', '--json'], { options: opts })).toBe(2);
      expect(await cmdAsks(['usage', '--json'], { options: opts })).toBe(0);
      expect(await cmdAsks(['--all', '--json'], { options: opts })).toBe(0);
    } finally { console.log = log; }
    expect(JSON.parse(lines[2]!)).toMatchObject({ schema: 'asks.usage.v1', pool: 'grok-ultra', reading: { pctUsed: 40, source: 'mason' } });
    expect(JSON.parse(lines[3]!)).toMatchObject({ schema: 'asks.v1', count: 1 });
  });
});

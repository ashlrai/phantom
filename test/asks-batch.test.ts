import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdAsks } from '../src/cli/asks.js';
import type { AskAnswerResult } from '../src/core/fleet/asks.js';
import {
  answerFromThread, answerOwnerAsk, buildAskBatch, listAskBatch, parseThreadReply, type OpenAsk, type OwnerAnswerDeps,
} from '../src/core/fleet/asks-batch.js';
import { emptyOwnerSettings } from '../src/core/comms/owner-channel.js';

const owner = { channel: 'desktop' as const, senderId: 'owner-one' };
const stranger = { channel: 'desktop' as const, senderId: 'stranger' };
const settings = { ...emptyOwnerSettings(), owners: { desktop: 'owner-one' } };
const ask = (over: Partial<OpenAsk> = {}): OpenAsk => ({
  id: 'nm-a', question: 'May I spend the gifted API credit?', kind: 'yes-no', askedAt: '2026-11-14T10:00:00.000Z', hardLimit: 'money', ...over,
});

/** A tiny in-memory ledger: first answer wins, like answerAsk. */
function fake(asks: OpenAsk[]): OwnerAnswerDeps & { writes: Array<[string, string]> } {
  const recorded = new Map<string, string>();
  const writes: Array<[string, string]> = [];
  return {
    settings,
    writes,
    batch: () => buildAskBatch(asks.filter(a => !recorded.has(a.id))),
    record: async (id, answer): Promise<AskAnswerResult> => {
      const first = recorded.get(id);
      const base = { schema: 'asks.answer.v1' as const, id, kind: null, source: null, answeredAt: null, reason: null };
      if (first !== undefined) return { ...base, status: 'already-answered', answer: first as never };
      if (!asks.some(a => a.id === id)) return { ...base, status: 'unknown', answer: null };
      recorded.set(id, answer); writes.push([id, answer]);
      return { ...base, status: 'answered', answer: answer as never };
    },
  };
}

describe('buildAskBatch', () => {
  it('orders oldest first, unknown time last, and numbers from 1', () => {
    const batch = buildAskBatch([
      ask({ id: 'nm-c', question: 'Third?', askedAt: null }),
      ask({ id: 'nm-b', question: 'Second?', askedAt: '2026-11-17T00:00:00.000Z' }),
      ask({ id: 'nm-a', question: 'First?', askedAt: '2026-11-13T00:00:00.000Z' }),
    ]);
    expect(batch.asks.map(a => [a.number, a.question])).toEqual([[1, 'First?'], [2, 'Second?'], [3, 'Third?']]);
    expect(batch.asks[2]!.askedAt).toBeNull();
    expect(batch.count).toBe(3);
  });

  it('merges the same question, keeps the oldest time, and answers every id', () => {
    const batch = buildAskBatch([
      ask({ id: 'nm-new', askedAt: '2026-11-18T00:00:00.000Z', question: 'May I  spend the gifted API credit? ' }),
      ask({ id: 'nm-old', askedAt: '2026-11-13T00:00:00.000Z' }),
    ]);
    expect(batch.count).toBe(1);
    expect(batch.asks[0]).toMatchObject({ id: 'nm-old', ids: ['nm-old', 'nm-new'], askedAt: '2026-11-13T00:00:00.000Z' });
  });

  it('gives each ask its allowed answers and a one-line what-happens', () => {
    const batch = buildAskBatch([
      ask(),
      ask({ id: 'nm-p', question: 'Pick one', kind: 'pick-one', choices: ['a', 'b'], hardLimit: null, askedAt: '2026-11-15T00:00:00.000Z' }),
      ask({ id: 'nm-s', question: 'Usage percent?', kind: 'short-value', hardLimit: null, askedAt: '2026-11-16T00:00:00.000Z' }),
    ]);
    expect(batch.asks.map(a => a.choices)).toEqual([['yes', 'no'], ['a', 'b'], []]);
    expect(batch.asks[0]!.whatHappens).toBe('The fleet may spend it.');
    expect(batch.asks[1]!.whatHappens).toMatch(/^Unknown/);
  });

  it('has no asks: count 0, so no card', () => {
    expect(buildAskBatch([])).toEqual({ schema: 'asks.batch.v1', count: 0, asks: [], ledger: 'available' });
  });
});

describe('answerOwnerAsk', () => {
  it('records a verified owner answer', async () => {
    const deps = fake([ask()]);
    const r = await answerOwnerAsk({ askId: 'nm-a', answer: 'yes', sender: owner }, deps);
    expect(r).toMatchObject({ status: 'answered', answer: 'yes' });
    expect(deps.writes).toEqual([['nm-a', 'yes']]);
  });

  it('refuses an unverified sender and records nothing', async () => {
    const deps = fake([ask()]);
    const r = await answerOwnerAsk({ askId: 'nm-a', answer: 'yes', sender: stranger }, deps);
    expect(r.status).toBe('refused');
    expect(r.message).toBe('Only the owner can answer. Nothing was recorded.');
    expect(deps.writes).toEqual([]);
  });

  it('rejects an answer that is not one of the choices', async () => {
    const deps = fake([ask()]);
    const r = await answerOwnerAsk({ askId: 'nm-a', answer: 'maybe', sender: owner }, deps);
    expect(r).toMatchObject({ status: 'invalid', message: 'Answer yes or no.' });
    expect(deps.writes).toEqual([]);
  });

  it('treats a repeated identical answer as already answered', async () => {
    const deps = fake([ask()]);
    await answerOwnerAsk({ askId: 'nm-a', answer: 'yes', sender: owner }, deps);
    const again = await answerOwnerAsk({ askId: 'nm-a', answer: 'yes', sender: owner }, deps);
    expect(again.status).toBe('already-answered');
    expect(deps.writes).toHaveLength(1);
  });

  it('refuses a conflicting second answer and keeps the first', async () => {
    const deps = fake([ask()]);
    await answerOwnerAsk({ askId: 'nm-a', answer: 'yes', sender: owner }, deps);
    const other = await answerOwnerAsk({ askId: 'nm-a', answer: 'no', sender: owner }, deps);
    expect(other).toMatchObject({ status: 'conflict', answer: 'yes' });
    expect(deps.writes).toEqual([['nm-a', 'yes']]);
  });

  it('answers every merged duplicate once', async () => {
    const deps = fake([ask({ id: 'nm-1' }), ask({ id: 'nm-2', askedAt: '2026-11-15T00:00:00.000Z' })]);
    expect((await answerOwnerAsk({ askId: 'nm-2', answer: 'no', sender: owner }, deps)).status).toBe('answered');
    expect(deps.writes.map(w => w[0]).sort()).toEqual(['nm-1', 'nm-2']);
  });

  it('says an unknown id is unknown, and a verified owner short answer is recorded through the ask\'s own check', async () => {
    const deps = fake([ask({ id: 'nm-s', kind: 'short-value' })]);
    expect((await answerOwnerAsk({ askId: 'nm-zz', answer: 'yes', sender: owner }, deps)).status).toBe('unknown');
    expect((await answerOwnerAsk({ askId: 'nm-s', answer: '42', sender: stranger }, deps)).status).toBe('refused');
    expect(deps.writes).toEqual([]);
    expect((await answerOwnerAsk({ askId: 'nm-s', answer: '42', sender: owner }, deps)).status).toBe('answered');
    expect(deps.writes).toEqual([['nm-s', '42']]);
  });
});

describe('parseThreadReply', () => {
  const batch = buildAskBatch([
    ask({ id: 'nm-a', askedAt: '2026-11-13T00:00:00.000Z' }),
    ask({ id: 'nm-b', question: 'Which?', kind: 'pick-one', choices: ['red', 'blue'], askedAt: '2026-11-14T00:00:00.000Z' }),
    ask({ id: 'nm-c', question: 'Percent?', kind: 'short-value', askedAt: '2026-11-15T00:00:00.000Z' }),
  ]);
  it('maps a bare word to the oldest ask', () => {
    expect(parseThreadReply('Yes', batch)).toMatchObject({ answer: 'yes', ask: { id: 'nm-a' } });
    expect(parseThreadReply('no.', batch)?.answer).toBe('no');
  });
  it('maps "2 blue" and "blue 2" to the numbered ask', () => {
    expect(parseThreadReply('2 blue', batch)).toMatchObject({ answer: 'blue', ask: { id: 'nm-b' } });
    expect(parseThreadReply('blue 2', batch)?.ask.id).toBe('nm-b');
  });
  it('ignores anything else', () => {
    for (const text of ['', 'yes please', '9 yes', '2 yes', '3 yes', 'banana', 'yes 1 2']) expect(parseThreadReply(text, batch)).toBeNull();
    expect(parseThreadReply('yes', { asks: [] })).toBeNull();
  });
  it('answers from a thread only for the owner', async () => {
    const deps = fake([ask()]);
    expect(await answerFromThread('what is up', owner, deps)).toBeNull();
    expect((await answerFromThread('yes', stranger, deps))?.status).toBe('refused');
    expect((await answerFromThread('yes', owner, deps))?.status).toBe('answered');
    expect(deps.writes).toEqual([['nm-a', 'yes']]);
  });
});

describe('phm asks list --json', () => {
  afterEach(() => vi.restoreAllMocks());
  it('prints asks.batch.v1 with the documented keys', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await cmdAsks(['list', '--json'], { batch: () => buildAskBatch([ask()]) });
    expect(code).toBe(0);
    const out = JSON.parse(log.mock.calls[0]![0] as string);
    expect(Object.keys(out).sort()).toEqual(['asks', 'count', 'ledger', 'schema']);
    expect(Object.keys(out.asks[0]).sort()).toEqual(
      ['askedAt', 'choices', 'expires', 'hardLimit', 'id', 'ids', 'kind', 'number', 'question', 'whatHappens']);
    expect(out.schema).toBe('asks.batch.v1');
  });
  it('shows an unreadable ledger as unknown, not as zero', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await cmdAsks(['list'], { batch: () => listAskBatch({}, () => ({ schema: 'asks.v1', asOf: '', ledger: 'unavailable', count: 0, asks: [], fleetDecides: 0 })) });
    expect(code).toBe(1);
    expect(log.mock.calls[0]![0]).toMatch(/unknown/);
  });
});

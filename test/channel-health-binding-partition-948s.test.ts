import { describe, expect, it } from 'vitest';
import { readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';

const now = new Date('2026-11-13T18:00:00.000Z');
const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const source = (overrides: Partial<ChannelSource> = {}): ChannelSource => ({
  configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [], ...overrides,
});
const run = async (inbound: string[], answeredAt: string[], unansweredAt: string[]) =>
  (await readChannelHealth({ now: () => now, host: 'fake', sources: {
    slack: source({ inbound: () => inbound, replyBinding: () => ({ store: 'ok', answeredAt, unansweredAt, futureDated: 0 }) }),
    imessage: source(),
  } })).channels[0]!;

describe('reply binding partition', () => {
  it.each([
    ['omitted pending', [at(20), at(5)], [at(5)], []],
    ['invented answer', [at(20)], [at(5)], []],
    ['double counted', [at(20)], [at(20)], [at(20)]],
  ])('retains inbound evidence for %s', async (_name, inbound, answered, unanswered) => {
    const result = await run(inbound, answered, unanswered);
    expect(result).toMatchObject({ state: 'DEGRADED', unansweredCount: inbound.length,
      missing: ['slack reply binding partition mismatch'], proof: { requestCoverage: 'unproven' } });
    expect(result.proof).not.toHaveProperty('answeredCount');
  });

  it('reports uncertainty for a recent mismatch without leaking source contents', async () => {
    const result = await run([at(5)], [], []);
    expect(result).toMatchObject({ state: 'UNKNOWN', unansweredCount: 1,
      missing: ['slack reply binding partition mismatch'], proof: { requestCoverage: 'unproven' } });
    expect(result.proof).not.toHaveProperty('answeredCount');
  });

  it('preserves multiplicity for distinct equal-time requests', async () => {
    const result = await run([at(5), at(5)], [at(5)], [at(5)]);
    expect(result).toMatchObject({ state: 'LIVE', unansweredCount: 1,
      proof: { requestCoverage: 'unproven', answeredCount: 1 } });
    expect((await run([at(5), at(5)], [at(5)], [])).state).toBe('UNKNOWN');
  });

  it('accepts reordered and normalized exact partitions', async () => {
    const result = await run([at(5), at(4)], [at(4), '2026-11-13T12:55:00-05:00'], []);
    expect(result).toMatchObject({ state: 'LIVE', unansweredCount: 0,
      proof: { requestCoverage: 'verified', answeredCount: 2 } });
  });

  it('ignores future and expired observations equally on both sides', async () => {
    const result = await run([at(5), at(-5), at(120)], [at(5), at(-10)], []);
    expect(result).toMatchObject({ state: 'UNKNOWN', unansweredCount: 0,
      missing: ['slack future-dated receipt ignored'], proof: { requestCoverage: 'verified', answeredCount: 1, futureDatedCount: 1 } });
  });
});

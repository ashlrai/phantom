import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSlackEvidence } from '../src/cli/fleet-slack-evidence.js';
import { readSlackEvidenceBundle } from '../src/core/agents/slack-evidence-bundle.js';

const thread = '1234567890.123456';
const args = ['--thread', thread, '--channel', 'C12345678', '--max-age-seconds', '60', '--json'];
const now = () => new Date('2026-01-01T00:00:00.000Z');
const roots = { runsDir: '/synthetic/runs', stateRoot: '/synthetic/state', now };
type Bundle = ReturnType<typeof readSlackEvidenceBundle>;
const healthy: Bundle = {
  schema: 'phantom.fleet.slack-evidence.v1',
  scope: 'Local journal and send evidence only; does not prove current runtime reachability, durable task ownership, or execution.',
  thread, asOf: now().toISOString(),
  rows: [{ at: now().toISOString(), channelId: 'C12345678', threadTs: thread, messageTs: thread, ingress: 'posted', outcome: 'answered' }],
  counts: { total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 },
  sources: { journal: 'ok', sends: 'ok' },
  freshness: { maxAgeSeconds: 60, verdict: 'fresh', basis: 'Persisted ingress observation times; asOf is collection time, not a live probe.' },
};

afterEach(() => vi.restoreAllMocks());

describe('fleet slack-evidence CLI collector boundary', () => {
  it.each([new Error('/synthetic/private-marker'), '/synthetic/private-marker'])('contains collector failures', async (failure) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const readBundle = vi.fn((): Bundle => { throw failure; });
    expect(await cmdFleetSlackEvidence(args, { ...roots, readBundle })).toBe(1);
    const output = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toEqual({
      schema: healthy.schema, scope: healthy.scope, thread, asOf: now().toISOString(), rows: [],
      counts: { total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 },
      sources: { journal: 'degraded', sends: 'degraded' }, sourceState: 'unavailable',
    });
    expect(output).not.toContain('private-marker');
    expect(output).not.toContain('stack');
    expect(output).not.toContain('/synthetic');
  });

  it('uses a safe epoch when the clock is invalid or throws', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const clock of [() => new Date(NaN), () => { throw new Error('private-clock'); }]) {
      expect(await cmdFleetSlackEvidence(args, { ...roots, now: clock, readBundle: () => { throw 1; } })).toBe(1);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).asOf).toBe('1970-01-01T00:00:00.000Z');
    }
  });

  it('rejects invalid arguments before collecting', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const readBundle = vi.fn(() => healthy);
    for (const invalid of [[], ['--thread', 'invalid', '--json'], ['--thread', thread], [...args, '--extra']]) {
      expect(await cmdFleetSlackEvidence(invalid, { ...roots, readBundle })).toBe(2);
    }
    expect(readBundle).not.toHaveBeenCalled();
  });

  it('preserves healthy output and passes validated options to the collector', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const readBundle = vi.fn(() => healthy);
    expect(await cmdFleetSlackEvidence(args, { ...roots, readBundle })).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(healthy);
    expect(readBundle).toHaveBeenCalledWith(thread, { ...roots, channelId: 'C12345678', maxAgeSeconds: 60 });
  });

  it('does not report success for stale or unknown ingress evidence', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const stale: Bundle = { ...healthy, freshness: { ...healthy.freshness!, verdict: 'stale' } };
    const unknown: Bundle = { ...healthy, rows: [{ ...healthy.rows[0]!, ingress: 'unknown' }] };
    for (const bundle of [stale, unknown]) {
      expect(await cmdFleetSlackEvidence(args, { ...roots, readBundle: () => bundle })).toBe(1);
    }
  });
});

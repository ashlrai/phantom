import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSlackEvidence } from '../src/cli/fleet-slack-evidence.js';
import type { readSlackEvidenceBundle } from '../src/core/agents/slack-evidence-bundle.js';

const thread = '1234567890.123456';
const message = '1234567891.123456';
const other = '1234567892.123456';
const channel = 'C12345678';
const asOf = '2026-01-01T00:01:00.000Z';
type Bundle = ReturnType<typeof readSlackEvidenceBundle>;
const row: Bundle['rows'][number] = { at: '2026-01-01T00:00:30.000Z', channelId: channel, threadTs: thread, messageTs: message, ingress: 'posted', outcome: 'answered' };
const bundle: Bundle = {
  schema: 'phantom.fleet.slack-evidence.v1', scope: 'synthetic scope', thread, asOf,
  rows: [row, { ...row, messageTs: other, outcome: 'unanswered', at: '2025-01-01T00:00:00.000Z' },
    { ...row, channelId: 'C87654321', outcome: 'unanswered' }],
  counts: { total: 3, answered: 1, uncertain: 0, busFailed: 0, unanswered: 2 },
  sources: { journal: 'ok', sends: 'ok' },
  freshness: { maxAgeSeconds: 60, verdict: 'stale', basis: 'Persisted ingress observation times; asOf is collection time, not a live probe.' },
};
const args = ['--thread', thread, '--channel', channel, '--message', message, '--max-age-seconds', '60', '--json'];
afterEach(() => vi.restoreAllMocks());

async function run(input: string[], data: Bundle = bundle) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const readBundle = vi.fn(() => data);
  const exit = await cmdFleetSlackEvidence(input, { readBundle });
  const output = String(log.mock.calls.at(-1)?.[0]);
  log.mockRestore();
  return { exit, output, readBundle };
}

describe('request-specific Slack evidence', () => {
  it('selects exact channel and message before counts and freshness', async () => {
    const { exit, output } = await run(args);
    expect(exit).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ selection: { channelId: channel, messageTs: message }, rows: [row],
      counts: { total: 1, answered: 1, unanswered: 0 }, freshness: { verdict: 'fresh' }, sources: bundle.sources, scope: bundle.scope });
  });

  it('fails for absent, unknown, unanswered, uncertain, stale, or degraded evidence, including duplicates', async () => {
    const cases: Bundle[] = [
      { ...bundle, rows: [] },
      { ...bundle, rows: [{ ...row, channelId: 'C87654321' }] },
      { ...bundle, rows: [{ ...row, messageTs: other }] },
      { ...bundle, rows: [{ ...row, ingress: 'unknown' }] },
      { ...bundle, rows: [row, { ...row, outcome: 'unanswered' }] },
      { ...bundle, rows: [{ ...row, outcome: 'uncertain' }] },
      { ...bundle, rows: [{ ...row, at: '2025-01-01T00:00:00.000Z' }] },
      { ...bundle, sources: { ...bundle.sources, sends: 'degraded' } },
    ];
    for (const data of cases) {
      const { exit, output } = await run(args, data);
      expect(exit).toBe(1);
      const result = JSON.parse(output);
      expect(result.selection).toEqual({ channelId: channel, messageTs: message });
      if (data.rows.length === 2) expect(result.rows).toHaveLength(2);
    }
  });

  it('rejects missing channel, malformed and repeated flags before reading', async () => {
    for (const invalid of [
      ['--thread', thread, '--message', message, '--json'],
      ['--thread', thread, '--channel', channel, '--message', 'bad', '--json'],
      [...args, '--message', message], [...args, '--channel', channel], [...args, '--thread', thread],
      [...args, '--max-age-seconds', '60'], [...args, '--json'],
    ]) {
      const result = await run(invalid);
      expect(result.exit).toBe(2);
      expect(result.readBundle).not.toHaveBeenCalled();
    }
  });

  it('preserves unselected output and sanitizes unavailable collection', async () => {
    const unselected = await run(['--thread', thread, '--json']);
    expect(unselected.exit).toBe(1);
    expect(JSON.parse(unselected.output)).toEqual(bundle);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exit = await cmdFleetSlackEvidence(args, { readBundle: () => { throw new Error('private-marker'); }, now: () => new Date(asOf) });
    const output = String(log.mock.calls[0]?.[0]);
    expect(exit).toBe(1);
    expect(JSON.parse(output)).toMatchObject({ sourceState: 'unavailable', selection: { channelId: channel, messageTs: message }, rows: [] });
    expect(output).not.toContain('private-marker');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  deriveAskStatusEvents,
  isAskStatusEvent,
  type AskStatusEvent,
} from '../src/core/ask/status-stream.js';
import { cmdAsk } from '../src/cli/ask.js';

const jobsPath = 'test/fixtures/ask-status/jobs.jsonl';
const jobs = readFileSync(jobsPath, 'utf8');
const row = (value: object): string => JSON.stringify(value) + '\n';

function statesFor(events: AskStatusEvent[], askId: string): string[] {
  return events.filter((e) => e.ask_id === askId).map((e) => e.state);
}

describe('deriveAskStatusEvents', () => {
  const events = deriveAskStatusEvents(jobs);

  it('yields the queued -> running -> merged sequence for a journaled lifecycle', () => {
    expect(statesFor(events, 'RQ-ASK-20261027-7K2Q')).toEqual(['queued', 'running', 'merged']);
  });

  it('yields queued -> running -> merged from a single finish record carrying lifecycle timestamps', () => {
    expect(statesFor(events, 'RQ-ASK-20261027-3C7D')).toEqual(['queued', 'running', 'merged']);
  });

  it('treats a bare finish as verifying and a following outcome as the terminal state', () => {
    expect(statesFor(events, 'RQ-ASK-20261027-9B4F'))
      .toEqual(['queued', 'running', 'verifying', 'failed']);
    const failed = events.find((e) => e.ask_id === 'RQ-ASK-20261027-9B4F' && e.state === 'failed');
    expect(failed).toMatchObject({ reason: 'empty_diff', ts: '2026-10-27T02:05:00Z' });
  });

  it('carries ledger attributes into the terminal event', () => {
    const merged = events.find((e) => e.ask_id === 'RQ-ASK-20261027-7K2Q' && e.state === 'merged');
    expect(merged).toMatchObject({
      schema: 'ask.status.v1',
      job_id: 'RQ-ASK-20261027-7K2Q-A',
      pool: 'devin',
      ts: '2026-10-27T01:45:00Z',
      pr: 1234,
      pr_url: 'https://github.com/ashlrai/phantom/pull/1234',
      merged_at: '2026-10-27T01:44:00Z',
      reverted_at: null,
      checks: 'success',
      tokens_total: 182000,
      wall_s: 2400,
    });
  });

  it('derives wall_s from started to finished when the record omits it', () => {
    const merged = events.find((e) => e.ask_id === 'RQ-ASK-20261027-3C7D' && e.state === 'merged');
    expect(merged).toMatchObject({ job_id: 'RQ-ASK-20261027-3C7D', pool: 'codex-cmp', wall_s: 1680 });
  });

  it('maps a cancel event to failed with a reason', () => {
    const cancel = events.find((e) => e.ask_id === 'RQ-ASK-20261027-8H2K');
    expect(cancel).toMatchObject({ state: 'failed', reason: 'cancelled', ts: '2026-10-27T04:00:00Z' });
  });

  it('skips non-ask jobs and regressive transitions', () => {
    expect(events.some((e) => e.job_id === 'RQ-DRAIN-999')).toBe(false);
    // The trailing launch line for 7K2Q-A is regressive and emits nothing.
    expect(events.filter((e) => e.job_id === 'RQ-ASK-20261027-7K2Q-A' && e.state === 'running'))
      .toHaveLength(1);
  });

  it('emits only records that satisfy the ask.status.v1 contract', () => {
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(isAskStatusEvent(event)).toBe(true);
  });

  it('derives the ask id from an RQ-ASK job id without an explicit ask_id field', () => {
    const derived = deriveAskStatusEvents(
      row({ event: 'enqueue', job_id: 'RQ-ASK-20261028-Z9Y8-C', at: '2026-10-28T00:00:00Z' }) +
      row({ event: 'finish', job_id: 'RQ-ASK-20261028-Z9Y8-C', at: '2026-10-28T01:00:00Z', outcome: 'merged' }),
    );
    expect(derived.map((e) => [e.ask_id, e.state])).toEqual([
      ['RQ-ASK-20261028-Z9Y8', 'queued'],
      ['RQ-ASK-20261028-Z9Y8', 'merged'],
    ]);
    expect(derived[0]!.job_id).toBe('RQ-ASK-20261028-Z9Y8-C');
  });

  it('recovers the arc when only the finish record stamps the ask id', () => {
    const derived = deriveAskStatusEvents(
      row({ event: 'enqueue', job_id: 'RQ-ASK-20261028-P4M6-A', at: '2026-10-28T00:00:00Z' }) +
      row({ event: 'launch', job_id: 'RQ-ASK-20261028-P4M6-A', at: '2026-10-28T00:05:00Z' }) +
      row({ event: 'finish', job_id: 'RQ-ASK-20261028-P4M6-A', ask_id: 'RQ-ASK-20261028-P4M6',
        at: '2026-10-28T01:00:00Z', outcome: 'merged' }),
    );
    expect(derived.map((e) => [e.state, e.ts])).toEqual([
      ['queued', '2026-10-28T00:00:00Z'],
      ['running', '2026-10-28T00:05:00Z'],
      ['merged', '2026-10-28T01:00:00Z'],
    ]);
    expect(derived.every(isAskStatusEvent)).toBe(true);
  });

  it('rejects malformed lines loudly and ignores unrecognized events', () => {
    expect(() => deriveAskStatusEvents(jobs + '{')).toThrow('Invalid JSON at jobs line 13');
    expect(() => deriveAskStatusEvents('[1]')).toThrow('Invalid event at jobs line 1');
    expect(deriveAskStatusEvents(
      row({ event: 'mystery', job_id: 'RQ-ASK-20261028-Z9Y8', at: '2026-10-28T00:00:00Z' }) +
      row({ note: 'no event name' }),
    )).toEqual([]);
  });

  it('validator rejects missing, extra and out-of-shape fields', () => {
    const merged = events.find((e) => e.state === 'merged')!;
    expect(isAskStatusEvent(merged)).toBe(true);
    expect(isAskStatusEvent({ ...merged, extra: 1 })).toBe(false);
    expect(isAskStatusEvent({ ...merged, ts: undefined })).toBe(false);
    expect(isAskStatusEvent({ ...merged, ts: '2026-10-27 01:45:00' })).toBe(false);
    expect(isAskStatusEvent({ ...merged, pool: 'unknown-pool' })).toBe(false);
    expect(isAskStatusEvent({ ...merged, pr_url: 'https://example.com/pull/1' })).toBe(false);
    expect(isAskStatusEvent('ask.status.v1')).toBe(false);
  });
});

describe('phm ask status', () => {
  async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const w = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    const e = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    });
    try {
      return { code: await cmdAsk(args), out: out.join(''), err: err.join('') };
    } finally {
      w.mockRestore();
      e.mockRestore();
    }
  }

  it('prints the derived stream as JSONL with --json', async () => {
    const { code, out } = await run(['status', '--jobs', jobsPath, '--json']);
    expect(code).toBe(0);
    const lines = out.trim().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(lines.every(isAskStatusEvent)).toBe(true);
    const merged = lines.find((l) => (l as AskStatusEvent).ask_id === 'RQ-ASK-20261027-7K2Q'
      && (l as AskStatusEvent).state === 'merged') as AskStatusEvent;
    expect(merged.pr_url).toBe('https://github.com/ashlrai/phantom/pull/1234');
  });

  it('prints a human-readable stream by default', async () => {
    const { code, out } = await run(['status', '--jobs', jobsPath]);
    expect(code).toBe(0);
    expect(out).toContain('queued');
    expect(out).toContain('running');
    expect(out).toContain('merged');
    expect(out).toContain('RQ-ASK-20261027-7K2Q-A');
  });

  it('exits 1 when the ledger is missing and 2 on bad usage', async () => {
    const missing = await run(['status', '--jobs', 'test/fixtures/ask-status/absent.jsonl']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('absent.jsonl');
    expect((await run(['status', '--jobs'])) .code).toBe(2);
    expect((await run(['status', '--bogus'])).code).toBe(2);
  });

  it('shows status in ask --help without breaking the question path', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('ask status');
    expect(help.out).toContain('--jobs');
    // A question is still required when no verb is given.
    expect((await run([])).code).toBe(2);
  });
});

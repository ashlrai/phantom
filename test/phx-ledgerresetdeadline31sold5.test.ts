import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdResourceLedger } from '../src/cli/resource-ledger.js';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';

const now = Date.parse('2036-10-31T12:00:00Z');
const iso = (seconds: number) => new Date(now + seconds * 1000).toISOString();
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fake-reset-deadline-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  const personalCodexHome = join(root, 'personal');
  await mkdir(join(runsDir, 'queue'), { recursive: true });
  await mkdir(join(runsDir, 'metrics'), { recursive: true });
  await writeFile(join(runsDir, 'queue/status.json'), JSON.stringify({ last_tick: iso(-60),
    lanes: { 'codex-personal': {}, claude: {}, devin: {}, passed: {}, unknown: {}, invalid: {}, later: {}, atstart: {} },
    budget: {
      'codex-personal': { weekly_used_pct: 80, reset_at: iso(900), source: 'status' },
      claude: { weekly_used_pct: 40, reset_at: iso(3600), source: 'claude-weekly' },
      devin: { credits_remaining: 42, reset_at: iso(10), source: 'devin-credits' },
      passed: { reset_at: iso(-1) }, unknown: {}, invalid: { reset_at: 'bad' },
      later: { reset_at: iso(3601) }, atstart: { reset_at: iso(0) },
    } }));
  await writeFile(join(runsDir, 'metrics/api-spend.jsonl'), [
    { ts: iso(-1), model: 'fake-a', input_tokens: 1 },
    { ts: iso(-1), model: 'fake-b', input_tokens: 2 },
  ].map(row => JSON.stringify(row)).join('\n'));
  const sessions = join(personalCodexHome, 'sessions', '2036', '10', '31');
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, 'rollout-fake.jsonl'), JSON.stringify({ timestamp: iso(-30), type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    primary: { used_percent: 10, window_minutes: 300, resets_at: (now + 20_000) / 1000 },
    secondary: { used_percent: 73, window_minutes: 10080, resets_at: (now + 1_800_000) / 1000 },
  } } }) + '\n');
  return { runsDir, read: () => readResourceLedger({ runsDir, personalCodexHome, now: () => now }) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('ledger reset deadline', () => {
  it('selects future resets through the inclusive deadline and retains provider evidence', async () => {
    const { read } = await fixture();
    const original = await read();
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reader = vi.fn(read);
    expect(await cmdResourceLedger(['--json', '--resets-within-seconds', '3600'], reader)).toBe(0);
    expect(reader).toHaveBeenCalledOnce();
    const view = JSON.parse(String(out.mock.calls[0]![0]));
    expect(view.lanes.map((row: { lane: string }) => row.lane)).toEqual(['codex-personal', 'claude', 'devin']);
    expect(view.lanes).toEqual(original.lanes.filter(row => ['codex-personal', 'claude', 'devin'].includes(row.lane)));
    expect(view.lanes[0]).toMatchObject({ window: 'weekly', usedPct: 73, resetAt: iso(1800), source: 'codex-personal-sessions', quotaEvidence: { measuredQuota: { resetAt: iso(1800) } } });
    expect(view.lanes[1]).toMatchObject({ window: 'weekly', usedPct: 40, resetAt: iso(3600), source: 'claude-weekly' });
    expect(view.lanes[2]).toMatchObject({ window: 'credits', creditsRemaining: 42, resetAt: iso(10) });
    expect(JSON.stringify(view.lanes[1])).not.toMatch(/5h|fiveHour/i);
    expect(view.resetFilter).toEqual({ withinSeconds: 3600, deadline: iso(3600), unknownResetLanes: ['unknown', 'invalid'], global: ['generatedAt', 'asOf', 'sources', 'apiSpend', 'jobsMalformedRows'] });
    expect(view.sources).toEqual(original.sources);
    expect(view.apiSpend).toEqual(original.apiSpend);
  });

  it('composes lane, model and freshness selections and labels the text scope', async () => {
    const { read } = await fixture();
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const args = ['--lane', 'unknown', '--model', 'fake-b', '--resets-within-seconds', '3600', '--check-fresh-seconds', '60'];
    expect(await cmdResourceLedger(['--json', ...args], read, undefined, () => now)).toBe(0);
    const view = JSON.parse(String(out.mock.calls[0]![0]));
    expect(view.lanes).toEqual([]);
    expect(view.resetFilter.unknownResetLanes).toEqual(['unknown']);
    expect(view.resetFilter.global).toContain('apiSpend.rowsToday');
    expect(view.resetFilter.global).not.toContain('apiSpend');
    expect(view.apiSpend.rowsToday).toBe(2);
    expect(view.apiSpend.modelUsageToday.map((row: { model: string }) => row.model)).toEqual(['fake-b']);
    expect(view.freshnessCheck.result).toBe('pass');
    out.mockClear();
    expect(await cmdResourceLedger(args, read, undefined, () => now)).toBe(0);
    const text = out.mock.calls.flat().join('\n');
    expect(text).toContain(`Reset filter: after ${iso(0)} through ${iso(3600)} (3600 seconds)`);
    expect(text).toContain('Unknown or invalid reset lanes in lane scope: unknown');
    expect(text).toContain('sources and API spend totals are global');
    expect(text).toContain('Lanes: none matching reset filter');
  });

  it('handles zero, invalid reader timestamps and degraded or missing sources without inventing resets', async () => {
    const { read, runsDir } = await fixture();
    const original = await read();
    original.lanes.find(row => row.lane === 'invalid')!.resetAt = '2036-02-30T12:00:00Z';
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdResourceLedger(['--json', '--resets-within-seconds', '0'], async () => original)).toBe(0);
    const view = JSON.parse(String(out.mock.calls[0]![0]));
    expect(view.lanes).toEqual([]);
    expect(view.resetFilter).toMatchObject({ deadline: iso(0), unknownResetLanes: ['unknown', 'invalid'] });
    await writeFile(join(runsDir, 'queue/status.json'), '{');
    out.mockClear();
    expect(await cmdResourceLedger(['--json', '--resets-within-seconds', '3600'], read)).toBe(0);
    const degraded = JSON.parse(String(out.mock.calls[0]![0]));
    expect(degraded.sources).toEqual({ status: 'degraded', apiSpend: 'healthy', jobs: 'missing' });
    expect(degraded.lanes.map((row: { lane: string }) => row.lane)).toEqual(['codex-personal']);
    await rm(join(runsDir, 'queue/status.json'));
    out.mockClear();
    expect(await cmdResourceLedger(['--json', '--resets-within-seconds', '3600'], read)).toBe(0);
    expect(JSON.parse(String(out.mock.calls[0]![0])).sources.status).toBe('missing');
  });

  it('preserves default JSON and text and fails closed on invalid snapshot time or overflow', async () => {
    const { read } = await fixture();
    const original = await read();
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdResourceLedger(['--json'], read)).toBe(0);
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual(original);
    out.mockClear();
    expect(await cmdResourceLedger([], read)).toBe(0);
    expect(out.mock.calls.flat().join('\n')).not.toContain('Reset filter:');
    out.mockClear();
    expect(await cmdResourceLedger(['--resets-within-seconds', '1'], async () => ({ ...original, generatedAt: 'bad' }))).toBe(1);
    expect(await cmdResourceLedger(['--resets-within-seconds', '9007199254740991'], read)).toBe(1);
    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith('Unable to calculate reset deadline from snapshot and interval.\n');
    expect(await cmdResourceLedger(['--resets-within-seconds', '1'], async () => { throw new Error('fake'); })).toBe(1);
    expect(err).toHaveBeenCalledWith('Unable to read resource ledger.\n');
  });

  it.each([
    ['--resets-within-seconds'], ['--resets-within-seconds', '-1'], ['--resets-within-seconds', '1.5'],
    ['--resets-within-seconds', '9007199254740992'], ['--resets-within-seconds', '1', '--resets-within-seconds', '2'],
    ['--watch', '--resets-within-seconds', '0'], ['--lane', 'devin', '--wait-headroom-seconds', '1', '--resets-within-seconds', '1'],
  ])('rejects invalid arguments before reading: %j', async (...args) => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const read = vi.fn();
    expect(await cmdResourceLedger(args, read)).toBe(2);
    expect(read).not.toHaveBeenCalled();
  });

  it('documents the option without reading', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn();
    expect(await cmdResourceLedger(['--help'], read)).toBe(0);
    expect(out.mock.calls.flat().join('\n')).toContain('--resets-within-seconds N');
    expect(read).not.toHaveBeenCalled();
  });
});

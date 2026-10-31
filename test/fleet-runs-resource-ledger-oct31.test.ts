import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readResourceLedger, summarizeApiSpend } from '../src/core/fleet/runs-resource-ledger.js';

const fixture = join(process.cwd(), 'test/fixtures/runs-resource-ledger');
const now = Date.parse('2026-10-31T12:00:00Z');
const roots: string[] = [];
async function setup(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'resource-ledger-'));
  roots.push(root);
  await mkdir(join(root, 'queue'));
  await mkdir(join(root, 'metrics'));
  await Promise.all(['status.json', 'api-spend.jsonl'].map(async (file) => {
    await writeFile(join(root, file === 'status.json' ? 'queue' : 'metrics', file), await readFile(join(fixture, file)));
  }));
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('resource ledger', () => {
  it('maps the ordered lanes and scrubs attribution', async () => {
    const root = await setup();
    const ledger = await readResourceLedger({ runsDir: root, now: () => now });
    expect(ledger.sources).toEqual({ status: 'healthy', apiSpend: 'healthy', jobs: 'missing' });
    expect(ledger.asOf).toBe('2026-10-31T12:00:00Z');
    expect(ledger.lanes.map((l) => [l.lane, l.window])).toEqual([['codex-personal', 'weekly'], ['claude', 'weekly'], ['claude-api', 'credits'], ['local', 'none']]);
    expect(ledger.lanes[0]).toMatchObject({ running: 2, target: 3, held: false, usedPct: 45, resetAt: '2026-11-02T00:00:00Z', burnPctPerHour: 2, tokensPerHour6h: 1000, projectedExhaustion: '2026-11-01T00:00:00Z' });
    expect(ledger.lanes[0]!.source).not.toMatch(/\/Users\/example|fake-secret-value/);
    expect(ledger.lanes[2]!.creditsRemaining).toBe(25);
    expect(JSON.stringify(ledger)).not.toMatch(/"[^"]*(?:5h|fiveHour)[^"]*"\s*:/i);
  });
  it('includes budget-only lanes with null dispatch state', async () => {
    const root = await setup();
    const status = JSON.parse(await readFile(join(fixture, 'status.json'), 'utf8'));
    status.budget.extra = { credits_remaining: 0, source: 'x'.repeat(200) };
    await writeFile(join(root, 'queue/status.json'), JSON.stringify(status));
    const ledger = await readResourceLedger({ runsDir: root, now: () => now });
    expect(ledger.lanes.at(-1)).toMatchObject({ lane: 'extra', running: null, target: null, held: null, window: 'credits', creditsRemaining: 0, source: 'x'.repeat(160) });
  });
  it('summarizes local days and Monday-start weeks, including errors and observed costs', async () => {
    const lines = await readFile(join(fixture, 'api-spend.jsonl'), 'utf8');
    expect(summarizeApiSpend(lines, now, 0)).toEqual({ rowsToday: 2, errorsToday: 1, tokensInToday: 130, tokensOutToday: 25, usdToday: 1.25, usdWeek: 2, lastAt: '2026-10-31T10:00:00Z', models: ['claude-test-a', 'claude-test-b'] });
    expect(summarizeApiSpend(lines, now, 300).rowsToday).toBe(2);
    expect(summarizeApiSpend('{"ts":"2026-10-31T03:00:00Z","cost":2}', now, 300)).toMatchObject({ rowsToday: 0, usdToday: null, usdWeek: 2 });
    expect(summarizeApiSpend('{"ts":"2026-10-31T10:00:00Z","cost_estimated":true}', now, 0)).toMatchObject({ usdToday: null, usdWeek: null });
  });
  it('reads only the tail, skips its partial first line, and marks bad lines degraded', async () => {
    const root = await setup();
    const good = '{"ts":"2026-10-31T10:00:00Z","output_tokens":7}';
    await writeFile(join(root, 'metrics/api-spend.jsonl'), 'x'.repeat(512 * 1024) + '\n' + good + '\ninvalid\n');
    const ledger = await readResourceLedger({ runsDir: root, now: () => now });
    expect(ledger.sources.apiSpend).toBe('degraded');
    expect(ledger.apiSpend).toMatchObject({ rowsToday: 1, tokensOutToday: 7 });
  });
  it('distinguishes an empty jobs file from an unavailable or symlinked file', async () => {
    const root = await setup();
    const path = join(root, 'metrics/jobs.jsonl');
    expect((await readResourceLedger({ runsDir: root })).lanes[0]!.deadSignal).toBeNull();
    await writeFile(path, '');
    expect((await readResourceLedger({ runsDir: root })).lanes[0]!.deadSignal).toEqual({ lane: 'codex-personal', lastFinishes: 0, emptyFailures: 0, state: 'ok' });
    await rm(path);
    await symlink(join(fixture, 'api-spend.jsonl'), path);
    const ledger = await readResourceLedger({ runsDir: root });
    expect(ledger.sources.jobs).toBe('degraded');
    expect(ledger.lanes[0]!.deadSignal).toBeNull();
  });
  it('isolates missing, oversized, malformed and symlinked sources', async () => {
    const root = await setup();
    await rm(join(root, 'queue/status.json'));
    await rm(join(root, 'metrics/api-spend.jsonl'));
    expect(await readResourceLedger({ runsDir: root, now: () => now })).toMatchObject({ sources: { status: 'missing', apiSpend: 'missing', jobs: 'missing' }, lanes: [], apiSpend: null });
    await writeFile(join(root, 'queue/status.json'), ' '.repeat(1024 * 1024 + 1));
    await writeFile(join(root, 'metrics/api-spend.jsonl'), 'invalid\n');
    expect((await readResourceLedger({ runsDir: root, now: () => now })).sources).toEqual({ status: 'degraded', apiSpend: 'degraded', jobs: 'missing' });
    await rm(join(root, 'queue/status.json'));
    await symlink(join(fixture, 'status.json'), join(root, 'queue/status.json'));
    expect((await readResourceLedger({ runsDir: root, now: () => now })).sources.status).toBe('degraded');
  });
});

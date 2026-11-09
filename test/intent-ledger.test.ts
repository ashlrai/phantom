import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdIntent } from '../src/cli/intent.js';
import {
  addIntent,
  getIntent,
  importIntentFiles,
  intentSummary,
  noteMergedPulls,
  noteShippedRelease,
  sweepStale,
  updateIntent,
} from '../src/core/intent/ledger.js';
import { intentLedgerPath } from '../src/core/intent/store.js';
import { projectWorldModel } from '../src/core/world/project.js';

const NOW = '2026-11-09T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const WEEK = 8 * 24 * 60 * 60 * 1000;
const roots: string[] = [];

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'intent-ledger-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ashlr.intent-ledger/v1', () => {
  it('stores an item outside the repo and refuses secret-shaped text', async () => {
    const dir = await root();
    const item = await addIntent({
      title: 'Keep directives tracked', source: 'owner', owner: 'owner', rq: ['rq-intent-ledger-1'], now: NOW,
    }, dir);
    expect(item.rq).toEqual(['RQ-INTENT-LEDGER-1']);
    expect(item.status).toBe('proposed');
    expect(item.provenance[0]).toMatchObject({ source: 'owner', verbatim: false });
    const info = await stat(intentLedgerPath(dir));
    expect(info.mode & 0o777).toBe(0o600);
    const saved = await readFile(intentLedgerPath(dir), 'utf8');
    expect(saved).toContain('"schema":"ashlr.intent-ledger/v1"');
    await expect(addIntent({ title: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', source: 'owner', now: NOW }, dir)).rejects.toThrow(/Secret-shaped/);
    expect(await getIntent(item.id, dir)).toMatchObject({ id: item.id });
  });

  it('imports several JSONL files, dedups by RQ key, and keeps provenance', async () => {
    const dir = await root();
    const mac = join(dir, 'mac-seed.jsonl');
    const second = join(dir, 'core.jsonl');
    await writeFile(mac, [
      JSON.stringify({ id: 'mac-1', title: 'Route the model…', source: 'mac-lane', date: '2026-10-06', rq_key: 'RQ-ROUTER-1', status: 'queued', verbatim: true }),
      JSON.stringify({ id: 'mac-2', title: 'A second idea', source: 'mac-lane', date: '2026-10-07', rq_key: 'RQ-OTHER-1', status: 'proposed' }),
    ].join('\n'));
    await writeFile(second, JSON.stringify({ id: 'core-1', title: 'Route the model from core', source: 'core-memory', date: '2026-10-20', rq_key: 'RQ-ROUTER-1', status: 'in-progress' }));
    const result = await importIntentFiles([mac, second], { root: dir, now: NOW });
    expect(result).toEqual({ imported: 2, deduped: 1, items: 2 });
    const listed = await getIntent('mac-1', dir);
    expect(listed?.status).toBe('in-progress');
    expect(listed?.partial).toBe(true);
    expect(listed?.provenance.map((row) => row.source).sort()).toEqual(['core-memory', 'mac-lane']);
    expect(listed?.provenance.find((row) => row.source === 'mac-lane')?.verbatim).toBe(true);
    expect(listed?.rq).toEqual(['RQ-ROUTER-1']);
  });

  it('links a merged pull by title or branch and marks a release shipped', async () => {
    const dir = await root();
    await addIntent({ title: 'Ledger', source: 'owner', rq: ['RQ-INTENT-LEDGER-1'], status: 'in-progress', now: '2026-10-01T00:00:00.000Z' }, dir);
    await addIntent({ title: 'Already verified', source: 'owner', rq: ['RQ-DONE-1'], status: 'verified', now: '2026-10-01T00:00:00.000Z' }, dir);
    const linked = await noteMergedPulls([
      { repo: 'ashlrai/phantom', number: 12, title: 'bridge: RQ-INTENT-LEDGER-1', branch: 'cursor/other' },
      { repo: 'ashlrai/phantom', number: 13, title: 'unrelated', branch: 'cursor/RQ-DONE-1-fix' },
    ], { root: dir, now: NOW });
    expect(linked.updated).toBe(2);
    expect(await getIntent('int-unused', dir)).toBeNull();
    const items = (await import('../src/core/intent/ledger.js')).listIntents({ root: dir });
    const rows = (await items).items;
    const ledger = rows.find((row) => row.rq.includes('RQ-INTENT-LEDGER-1'));
    const done = rows.find((row) => row.rq.includes('RQ-DONE-1'));
    expect(ledger).toMatchObject({ status: 'merged', prs: [{ repo: 'ashlrai/phantom', number: 12, state: 'merged' }] });
    expect(done?.status).toBe('verified');
    expect(done?.prs[0]?.number).toBe(13);
    const shipped = await noteShippedRelease({ release: 'v3.31.0', notes: 'ships RQ-INTENT-LEDGER-1' }, { root: dir, now: NOW });
    expect(shipped.updated).toBe(1);
    const after = (await (await import('../src/core/intent/ledger.js')).listIntents({ root: dir })).items.find((row) => row.rq.includes('RQ-INTENT-LEDGER-1'));
    expect(after?.status).toBe('shipped');
    const verified = await updateIntent(after!.id, { evidence: { ref: 'world-model-test' }, now: NOW }, dir);
    expect(verified.status).toBe('verified');
  });

  it('re-queues stale work, then proposes and closes superseded items', async () => {
    const dir = await root();
    const live = await addIntent({ title: 'Still going', source: 'owner', rq: ['RQ-LIVE-1'], status: 'in-progress', now: '2026-10-01T00:00:00.000Z' }, dir);
    const idle = await addIntent({ title: 'No key yet', source: 'owner', status: 'proposed', now: '2026-10-01T00:00:00.000Z' }, dir);
    const plan = await sweepStale({ root: dir, now: NOW });
    expect(plan.applied).toBe(false);
    expect(plan.stale.find((row) => row.id === live.id)?.action).toBe('requeue');
    expect(plan.stale.find((row) => row.id === idle.id)?.action).toBe('propose-superseded');
    await sweepStale({ root: dir, apply: true, now: NOW });
    expect((await getIntent(live.id, dir))?.status).toBe('queued');
    expect((await getIntent(idle.id, dir))?.closureProposal).toBe('superseded');
    await sweepStale({ root: dir, apply: true, now: new Date(NOW_MS + WEEK).toISOString() });
    expect((await getIntent(idle.id, dir))?.status).toBe('superseded');
    expect((await getIntent(live.id, dir))?.closureProposal).toBe('superseded');
  });

  it('puts ledger totals on the world model and stale items in blind spots', async () => {
    const missing = projectWorldModel({
      nowMs: NOW_MS, sensors: null, roster: null, claims: null, busReadable: null, queue: null, ci: null,
      updatePhase: null, bottlenecks: null, bottlenecksObservedAt: null, stepsRemaining: null, stepsObservedAt: null, outcomes: null,
    });
    expect(missing.intents.items).toMatchObject({ value: null, freshness: 'unknown' });
    expect(JSON.stringify(missing.intents)).not.toContain('"value":0');
    const dir = await root();
    await addIntent({ title: 'Old', source: 'owner', rq: ['RQ-OLD-1'], status: 'queued', now: '2026-10-01T00:00:00.000Z' }, dir);
    const summary = await intentSummary({ root: dir, nowMs: NOW_MS });
    const model = projectWorldModel({
      nowMs: NOW_MS, sensors: null, roster: null, claims: null, busReadable: null, queue: null, ci: null,
      updatePhase: null, bottlenecks: null, bottlenecksObservedAt: null, stepsRemaining: null, stepsObservedAt: null, outcomes: null,
      intents: { ...summary, staleItems: summary.staleItems },
    });
    expect(model.intents).toMatchObject({
      items: { value: 1, freshness: 'fresh' },
      tracked: { value: 1, freshness: 'fresh' },
      stale: { value: 1, freshness: 'fresh' },
    });
    expect(model.blindSpots.some((spot) => spot.path.startsWith('intents.stale.') && spot.freshness === 'stale')).toBe(true);
  });

  it('runs the import command against a ledger document', async () => {
    const dir = await root();
    const file = join(dir, 'seed-ledger.json');
    await writeFile(file, JSON.stringify({
      schema: 'ashlr.intent-ledger/v1',
      items: [{ id: 'seed-1', title: 'From the seed', source: 'seed', date: '2026-10-26', rq_key: 'RQ-SEED-1', status: 'unknown' }],
    }));
    const previous = process.env['ASHLR_RUNS_DIR'];
    process.env['ASHLR_RUNS_DIR'] = dir;
    const lines: string[] = [];
    const log = console.log;
    console.log = (line?: unknown) => { lines.push(String(line)); };
    try {
      expect(await cmdIntent(['import', file, '--json'])).toBe(0);
    } finally {
      console.log = log;
      if (previous === undefined) delete process.env['ASHLR_RUNS_DIR'];
      else process.env['ASHLR_RUNS_DIR'] = previous;
    }
    const body = JSON.parse(lines.at(-1) ?? '{}') as { ok: boolean; items: number };
    expect(body).toMatchObject({ ok: true, items: 1 });
    expect(await getIntent('seed-1', dir)).toMatchObject({ status: 'unknown', rq: ['RQ-SEED-1'] });
  });
});

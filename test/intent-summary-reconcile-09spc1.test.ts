import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTENT_LEDGER_SCHEMA, type IntentItem, type IntentStatus } from '../src/core/intent/schema.js';
import { intentSummary, isStale, summarize } from '../src/core/intent/summary.js';
import { cmdFleetIntentSummary } from '../src/cli/fleet-intent-summary.js';

const at = '2026-01-01T00:00:00.000Z';
function item(status: IntentStatus, id = status): IntentItem {
  return { id, title: id, source: 'fixture', owner: 'owner', rq: [], prs: [], status,
    evidence: [], provenance: [], partial: false, closureProposal: null,
    lastTouchedAt: at, staleAfterMs: 1000, createdAt: at, updatedAt: at };
}

describe('retained intent summary', () => {
  it('preserves strict threshold, terminal statuses and counts', () => {
    const now = Date.parse(at);
    const rows = [item('merged'), item('queued'), ...(['shipped', 'verified', 'superseded', 'closed'] as const).map(s => item(s))];
    rows[0]!.rq = ['RQ-TEST-1', 'RQ-TEST-2'];
    rows[1]!.partial = true;
    expect(isStale(rows[0]!, now + 1000)).toBe(false);
    expect(isStale(rows[0]!, now + 1001)).toBe(true);
    for (const row of rows.slice(2)) expect(isStale(row, now + 1001)).toBe(false);
    expect(summarize({ schema: INTENT_LEDGER_SCHEMA, items: rows }, now + 1001)).toMatchObject({
      items: 6, tracked: 1, partial: 1, merged: 1, shipped: 1, verified: 1, stale: 2,
      staleItems: [{ id: 'merged', title: 'merged', status: 'merged' }, { id: 'queued', title: 'queued', status: 'queued' }],
    });
    expect(() => summarize({ schema: INTENT_LEDGER_SCHEMA, items: [] }, NaN)).toThrow();
  });

  it('distinguishes missing and empty files and leaves bytes unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'intent-summary-'));
    const previous = process.env['ASHLR_RUNS_DIR'];
    try {
      process.env['ASHLR_RUNS_DIR'] = root;
      expect((await intentSummary()).present).toBe(false);
      await mkdir(join(root, 'intent'));
      const path = join(root, 'intent', 'ledger.json');
      const bytes = JSON.stringify({ schema: INTENT_LEDGER_SCHEMA, items: [] }) + '\n';
      await writeFile(path, bytes);
      expect(await intentSummary()).toMatchObject({ present: true, items: 0 });
      const output: string[] = [];
      const log = console.log;
      console.log = (value: unknown) => { output.push(String(value)); };
      try { expect(await cmdFleetIntentSummary(['--json'])).toBe(0); }
      finally { console.log = log; }
      expect(JSON.parse(output[0]!)).toMatchObject({ present: true, items: 0 });
      expect(await readFile(path, 'utf8')).toBe(bytes);
      await expect(intentSummary({ nowMs: Infinity })).rejects.toThrow();
      const error = console.error;
      console.error = () => {};
      try { expect(await cmdFleetIntentSummary(['--bad'])).toBe(2); }
      finally { console.error = error; }
    } finally {
      if (previous === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});

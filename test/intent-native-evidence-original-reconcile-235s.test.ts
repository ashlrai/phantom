import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool } from '../src/core/mcp-native.js';
import { emptyLedger, type IntentItem, type IntentStatus } from '../src/core/intent/schema.js';
import { readLedger, writeLedger } from '../src/core/intent/store.js';

// Reconcile coverage for PR #4473 (test/intent-native-evidence-preservation-09spx1.test.ts @
// 4aaf149badca10f9142ef58da8f8d02c8b7515f5). The recovered suite
// test/intent-native-evidence-recovery-183.test.ts already proves every original
// assertion group; this file supplies only the assertions that suite does not
// make: terminal-status stability and provenance preservation after a *repeat*
// intent_link, which the original asserted via its post-repeat status array.
// All repos, PR numbers, RQ keys and releases are fake.
const at = '2026-11-05T21:46:00.000Z';
const item = (id: string, status: IntentStatus): IntentItem => ({
  id, title: id, source: 'fixture', owner: 'fixture', rq: [`RQ-${id.toUpperCase()}-1`], prs: [], status,
  evidence: [], provenance: [{ source: 'fixture', date: null, verbatim: true, partial: false }], partial: false,
  closureProposal: null, lastTouchedAt: at, staleAfterMs: 1000, createdAt: at, updatedAt: at,
});
const link = { repo: 'example/project', number: 12, title: 'RQ-ALPHA-1 RQ-BETA-1 RQ-GAMMA-1', at };
const call = (name: string, args: unknown) => callNativeTool(name, args);

let root = '';
const previous = process.env['ASHLR_RUNS_DIR'];
afterEach(async () => {
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previous;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

describe('native intent evidence original-PR reconcile (#4473)', () => {
  it('a repeated intent_link keeps terminal statuses and provenance on every matched row', async () => {
    root = await mkdtemp(join(tmpdir(), 'intent-native-reconcile-235s-'));
    process.env['ASHLR_RUNS_DIR'] = root;
    await writeLedger({ ...emptyLedger(), items: [
      item('alpha', 'queued'), item('beta', 'verified'), item('gamma', 'closed'), item('delta', 'superseded'),
    ] }, root);
    const before = await readLedger(root);

    expect((await call('intent_link', link)).isError).not.toBe(true);
    expect((await call('intent_link', link)).isError).not.toBe(true);

    const rows = (await readLedger(root)).items;
    // Original assertion: the status array after two identical links.
    expect(rows.map(row => row.status)).toEqual(['merged', 'verified', 'closed', 'superseded']);
    // Terminal directives matched by the pull keep status and provenance; only
    // open-for-merge rows transition, and provenance is never rewritten.
    for (const index of [1, 2, 3] as const) {
      expect(rows[index]!.status).toBe(before.items[index]!.status);
      expect(rows[index]!.provenance).toEqual(before.items[index]!.provenance);
    }
    expect(rows[0]!.provenance).toEqual(before.items[0]!.provenance);
    expect(rows[0]!.prs).toHaveLength(1);
    expect(rows[0]!.evidence).toHaveLength(2);
  });
});

/**
 * RQ-PHX-RECUTCOREC412 — recut anchor for the #5384 owner-qualification suite.
 * Exercises `intent_stale` through the real `callNativeTool` dispatch with a
 * seeded fake ledger: preview lists stale rows without writing, apply appends
 * only the sweep evidence row. Fake ids, paths and timestamps throughout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const OLD = '2026-10-01T00:00:00.000Z';
let root = '';
let previousRunsDir: string | undefined;

function item(id: string, status: IntentItem['status'], lastTouchedAt: string): IntentItem {
  return {
    id, title: `Directive ${id}`, source: 'fake note', owner: 'owner', rq: [`RQ-${id.toUpperCase()}-1`],
    prs: [], status, evidence: [], provenance: [], partial: false, closureProposal: null,
    lastTouchedAt, staleAfterMs: 60_000, createdAt: OLD, updatedAt: OLD,
  };
}

function payload(result: { content: { type: 'text'; text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content.map((entry) => entry.text).join('\n')) as Record<string, unknown>;
}

beforeEach(async () => {
  previousRunsDir = process.env['ASHLR_RUNS_DIR'];
  root = mkdtempSync(join(tmpdir(), 'recut-core-c412-'));
  mkdirSync(join(root, 'intent'), { recursive: true });
  process.env['ASHLR_RUNS_DIR'] = root;
  await writeLedger({ ...emptyLedger(), items: [
    item('stale-live', 'in-progress', OLD),
    item('fresh-live', 'in-progress', new Date().toISOString()),
  ] }, root);
});

afterEach(() => {
  if (previousRunsDir === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = previousRunsDir;
  rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('intent_stale through the real MCP dispatch (recut c412)', () => {
  it('is advertised as a closed append tool', () => {
    const tool = listNativeTools().find((entry) => entry.name === 'intent_stale');
    expect(tool).toBeDefined();
    expect(nativeToolSafety('intent_stale')).toBe('append');
    expect(tool!.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('previews the stale row without touching the ledger, then apply re-queues it', async () => {
    const before = readFileSync(intentLedgerPath(root), 'utf8');
    const preview = await callNativeTool('intent_stale', {});
    expect(preview.isError).not.toBe(true);
    expect(payload(preview)).toMatchObject({ ok: true, applied: false, updated: 0 });
    expect(payload(preview)['stale']).toEqual([
      { id: 'stale-live', title: 'Directive stale-live', status: 'in-progress', action: 'requeue' },
    ]);
    expect(readFileSync(intentLedgerPath(root), 'utf8')).toBe(before);

    const applied = await callNativeTool('intent_stale', { apply: true });
    expect(applied.isError).not.toBe(true);
    expect(payload(applied)).toMatchObject({ ok: true, applied: true, updated: 1 });
    const ledger = await readLedger(root);
    const swept = ledger.items.find((entry) => entry.id === 'stale-live')!;
    expect(swept.status).toBe('queued');
    expect(swept.evidence.at(-1)).toMatchObject({ kind: 'sweep', ref: 'requeue' });
    const fresh = ledger.items.find((entry) => entry.id === 'fresh-live')!;
    expect(fresh.status).toBe('in-progress');
    expect(fresh.evidence).toEqual([]);
  });
});

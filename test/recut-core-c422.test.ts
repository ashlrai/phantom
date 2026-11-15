/**
 * recut-core-c422 — pass C422 coverage for the RQ-PHX-INTENTMCPWIRE197S recut
 * (#5235): the intent_link / intent_ship native tools record caller-supplied
 * evidence through callNativeTool, moving a directive queued → merged →
 * shipped while terminal records stay put. Complements
 * test/intent-mcp-evidence-wire-197s.test.ts (schema listing, argument
 * validation, missing-ledger refusal) with the full lifecycle and result
 * payload shape. Hermetic: temp ASHLR_RUNS_DIR only.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callNativeTool, nativeToolSafety } from '../src/core/mcp-native.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { readLedger, writeLedger } from '../src/core/intent/store.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/core/sandbox/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../src/core/sandbox/policy.js', () => ({ killSwitchOn: () => false }));

const at = '2026-11-05T22:37:00.000Z';
const item = (id: string, status: IntentItem['status'], rq: string[]): IntentItem => ({
  id, title: `${id} directive`, source: 'recut-c422', owner: 'test', rq, prs: [], status,
  evidence: [], provenance: [], partial: false, closureProposal: null,
  lastTouchedAt: at, staleAfterMs: 3_600_000, createdAt: at, updatedAt: at,
});

let root = '';
const previous = process.env['ASHLR_RUNS_DIR'];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'recut-core-c422-'));
  process.env['ASHLR_RUNS_DIR'] = root;
});
afterEach(async () => {
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previous;
  await rm(root, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>) => {
  const result = await callNativeTool(name, args);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]!.text);
};

describe('intent_link / intent_ship lifecycle (recut of #5235)', () => {
  it('advertises append-class safety for both evidence tools', () => {
    expect(nativeToolSafety('intent_link')).toBe('append');
    expect(nativeToolSafety('intent_ship')).toBe('append');
  });

  it('moves a named directive queued → merged → shipped and reports each step', async () => {
    await writeLedger({ ...emptyLedger(), items: [item('alpha', 'queued', ['RQ-ALPHA-1']), item('beta', 'verified', ['RQ-BETA-2'])] }, root);

    const linked = await call('intent_link', {
      repo: 'example/project', number: 12, title: 'RQ-ALPHA-1 lands the core work',
      url: 'https://example.test/pull/12', at,
    });
    expect(linked).toMatchObject({ ok: true, updated: 1, matches: [{ id: 'alpha', status: 'merged' }] });

    const shipped = await call('intent_ship', { release: 'phantom-v9.9', rq: ['RQ-ALPHA-1'], at });
    expect(shipped).toMatchObject({ ok: true, updated: 1, matches: [{ id: 'alpha', status: 'shipped' }] });

    const saved = await readLedger(root);
    const alpha = saved.items.find((row) => row.id === 'alpha')!;
    expect(alpha.status).toBe('shipped');
    expect(alpha.prs).toEqual([{ repo: 'example/project', number: 12, state: 'merged', url: 'https://example.test/pull/12' }]);
    expect(alpha.evidence).toEqual([
      { at, kind: 'pr', ref: 'example/project#12' },
      { at, kind: 'release', ref: 'phantom-v9.9' },
    ]);
    const beta = saved.items.find((row) => row.id === 'beta')!;
    expect(beta).toMatchObject({ status: 'verified', prs: [], evidence: [] });
  });
});

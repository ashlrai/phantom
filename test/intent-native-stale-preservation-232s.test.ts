import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { emptyLedger, type IntentItem, type IntentStatus } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

// Recovered from PR #4591 (test/mcp-native-intent-evidence-09sqn1.test.ts) against
// the current native MCP dispatch path: intent_stale previews and applies the
// local stale sweep only. All repos, PR numbers, RQ keys and releases are fake.
let killed = false;
vi.mock('../src/core/sandbox/policy.js', async (load) => ({
  ...(await load<typeof import('../src/core/sandbox/policy.js')>()),
  killSwitchOn: () => killed,
}));

const old = '2026-11-01T00:00:00.000Z';
let root = '';
let previousRunsDir: string | undefined;

function item(id: string, status: IntentStatus, rq: string[], extra: Partial<IntentItem> = {}): IntentItem {
  return {
    id, title: `Directive ${id}`, source: 'fake note', owner: 'owner', rq, prs: [], status,
    evidence: [], provenance: [], partial: false, closureProposal: null,
    lastTouchedAt: old, staleAfterMs: 60_000, createdAt: old, updatedAt: old, ...extra,
  };
}

async function setup(items: IntentItem[] | null): Promise<void> {
  root = mkdtempSync(join(tmpdir(), 'intent-native-stale-'));
  process.env['ASHLR_RUNS_DIR'] = root;
  killed = false;
  if (items !== null) await writeLedger({ ...emptyLedger(), items }, root);
}

beforeEach(() => {
  previousRunsDir = process.env['ASHLR_RUNS_DIR'];
  killed = false;
});

afterEach(() => {
  if (previousRunsDir === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = previousRunsDir;
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function text(result: { content: { type: 'text'; text: string }[] }): string {
  return result.content.map((entry) => entry.text).join('\n');
}

function payload(result: { content: { type: 'text'; text: string }[] }): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

const fixture = (): IntentItem[] => [
  item('alpha', 'queued', ['RQ-ALPHA-1']),
  item('beta', 'verified', ['RQ-BETA-1']),
  item('gamma', 'closed', ['RQ-GAMMA-1']),
  item('delta', 'in-progress', ['RQ-DELTA-1']),
  item('epsilon', 'in-progress', ['RQ-EPSILON-1'], { staleAfterMs: 31_536_000_000 }),
  item('zeta', 'merged', ['RQ-ZETA-1']),
  item('theta', 'proposed', []),
];

type StaleRow = { id: string; status: string; action: string };

describe('native intent_stale tool (PR #4591 recovery)', () => {
  it('is discoverable through the real registry as a closed append tool', () => {
    const listed = new Map(listNativeTools().map((tool) => [tool.name, tool]));
    expect(nativeToolSafety('intent_stale')).toBe('append');
    const schema = listed.get('intent_stale')?.inputSchema as { additionalProperties?: boolean; required?: string[]; properties?: Record<string, unknown> };
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.required ?? []).toEqual([]);
    expect(Object.keys(schema?.properties ?? {})).toEqual(['apply']);
    expect(listed.has('intent_link')).toBe(true);
    expect(listed.has('intent_ship')).toBe(true);
  });

  it('previews stale directives without writes, then apply persists only tracking transitions', async () => {
    await setup(fixture());
    const path = intentLedgerPath(root);
    const before = readFileSync(path, 'utf8');

    for (const args of [{}, { apply: false }]) {
      const preview = await callNativeTool('intent_stale', args);
      expect(preview.isError, JSON.stringify(args)).not.toBe(true);
      const previewPayload = payload(preview);
      expect(previewPayload).toMatchObject({ ok: true, applied: false, updated: 0 });
      expect((previewPayload['stale'] as StaleRow[]).map((row) => [row.id, row.status, row.action])).toEqual([
        ['alpha', 'queued', 'requeue'], ['delta', 'in-progress', 'requeue'],
        ['zeta', 'merged', 'await-verification'], ['theta', 'proposed', 'propose-superseded'],
      ]);
      expect(readFileSync(path, 'utf8')).toBe(before);
    }

    const applied = await callNativeTool('intent_stale', { apply: true });
    expect(applied.isError).not.toBe(true);
    const appliedPayload = payload(applied);
    expect(appliedPayload).toMatchObject({ ok: true, applied: true, updated: 4 });
    const appliedRows = appliedPayload['stale'] as StaleRow[];
    expect(appliedRows.map((row) => [row.id, row.status, row.action])).toEqual([
      ['alpha', 'queued', 'requeue'], ['delta', 'queued', 'requeue'],
      ['zeta', 'merged', 'await-verification'], ['theta', 'proposed', 'propose-superseded'],
    ]);

    const ledger = await readLedger(root);
    expect(ledger.items.map((entry) => [entry.id, entry.status])).toEqual([
      ['alpha', 'queued'], ['beta', 'verified'], ['gamma', 'closed'], ['delta', 'queued'],
      ['epsilon', 'in-progress'], ['zeta', 'merged'], ['theta', 'proposed'],
    ]);
    for (const id of ['alpha', 'delta', 'zeta', 'theta']) {
      const entry = ledger.items.find((row) => row.id === id)!;
      expect(entry.evidence.at(-1)).toMatchObject({ kind: 'sweep' });
      expect(entry.lastTouchedAt > old).toBe(true);
    }
    expect(ledger.items.find((entry) => entry.id === 'alpha')!.evidence.at(-1)).toMatchObject({ ref: 'requeue' });
    expect(ledger.items.find((entry) => entry.id === 'zeta')!.evidence.at(-1)).toMatchObject({ ref: 'await-verification' });
    expect(ledger.items.find((entry) => entry.id === 'theta')!.evidence.at(-1)).toMatchObject({ ref: 'propose-superseded' });
    // Terminal and fresh entries are untouched; nothing closes, supersedes or dispatches.
    expect(ledger.items[1]).toEqual(fixture()[1]);
    expect(ledger.items[2]).toEqual(fixture()[2]);
    expect(ledger.items[4]).toEqual(fixture()[4]);
    expect(ledger.items.every((entry) => entry.status !== 'superseded' && entry.closureProposal === null)).toBe(true);
  });

  it('a repeated apply reports nothing stale and leaves the ledger bytes unchanged', async () => {
    await setup(fixture());
    const path = intentLedgerPath(root);
    expect((await callNativeTool('intent_stale', { apply: true })).isError).not.toBe(true);
    const afterFirst = readFileSync(path, 'utf8');
    const second = await callNativeTool('intent_stale', { apply: true });
    expect(second.isError).not.toBe(true);
    expect(payload(second)).toMatchObject({ ok: true, applied: true, updated: 0, stale: [] });
    expect(readFileSync(path, 'utf8')).toBe(afterFirst);
  });

  it('treats a missing ledger as empty: preview and apply succeed without creating a file', async () => {
    await setup(null);
    for (const args of [{}, { apply: true }]) {
      const result = await callNativeTool('intent_stale', args);
      expect(result.isError, JSON.stringify(args)).not.toBe(true);
      expect(payload(result)).toMatchObject({ ok: true, stale: [], updated: 0 });
    }
    expect(() => statSync(intentLedgerPath(root))).toThrowError(/ENOENT/);
  });

  it('rejects invalid arguments with sanitized errors and never writes or echoes input', async () => {
    await setup(fixture());
    const path = intentLedgerPath(root);
    const before = readFileSync(path, 'utf8');
    const canary = 'CANARY-STALE-DO-NOT-ECHO';
    const invalid: [string, unknown][] = [
      ['intent_stale', { apply: 'yes' }],
      ['intent_stale', { apply: 1 }],
      ['intent_stale', { apply: true, now: '2026-11-09T00:00:00.000Z' }],
      ['intent_stale', { apply: true, root: '/tmp/elsewhere' }],
      ['intent_stale', { apply: true, extra: canary }],
      ['intent_stale', [true]],
      ['intent_stale', null],
      ['intent_stale', 'apply'],
      ['intent_stale', { apply: null }],
    ];
    for (const [name, args] of invalid) {
      const result = await callNativeTool(name, args);
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(text(result)).not.toContain('/tmp/elsewhere');
      expect(text(result)).not.toContain(canary);
      expect(readFileSync(path, 'utf8')).toBe(before);
    }
  });

  it('fails sanitized on a corrupt ledger and preserves the bytes', async () => {
    await setup(fixture());
    const path = intentLedgerPath(root);
    writeFileSync(path, '{corrupt-ledger');
    for (const args of [{}, { apply: true }]) {
      const result = await callNativeTool('intent_stale', args);
      expect(result.isError).toBe(true);
      expect(text(result)).not.toContain('{corrupt-ledger');
    }
    expect(readFileSync(path, 'utf8')).toBe('{corrupt-ledger');
  });

  it('kill switch refuses the append-class tool while arguments still validate first', async () => {
    await setup(fixture());
    const path = intentLedgerPath(root);
    const before = readFileSync(path, 'utf8');
    killed = true;
    for (const args of [{ apply: true }, {}]) {
      const result = await callNativeTool('intent_stale', args);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('kill switch');
    }
    const invalid = await callNativeTool('intent_stale', { apply: 'yes' });
    expect(invalid.isError).toBe(true);
    expect(text(invalid)).toContain('Invalid arguments');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('keeps the recovered link/ship evidence path working alongside intent_stale', async () => {
    await setup(fixture());
    const linked = await callNativeTool('intent_link', {
      repo: 'example/project', number: 42, title: 'Land RQ-ALPHA-1',
      branch: 'feat/rq-alpha-1', url: 'https://example.invalid/pull/42',
    });
    expect(linked.isError).not.toBe(true);
    expect(payload(linked)).toMatchObject({ ok: true, updated: 1, matches: [{ id: 'alpha', status: 'merged' }] });
    let ledger = await readLedger(root);
    expect(ledger.items.find((entry) => entry.id === 'alpha')!.prs)
      .toEqual([{ repo: 'example/project', number: 42, url: 'https://example.invalid/pull/42', state: 'merged' }]);

    const shipped = await callNativeTool('intent_ship', { release: 'v9.9.9-fake', rq: ['RQ-ALPHA-1'] });
    expect(shipped.isError).not.toBe(true);
    expect(payload(shipped)).toMatchObject({ ok: true, updated: 1, matches: [{ id: 'alpha', status: 'shipped' }] });
    ledger = await readLedger(root);
    expect(ledger.items.find((entry) => entry.id === 'alpha')!.status).toBe('shipped');
    expect(ledger.items.find((entry) => entry.id === 'alpha')!.evidence.map((row) => row.kind)).toEqual(['pr', 'release']);
    // Terminal shipped entries are not stale candidates.
    const stale = await callNativeTool('intent_stale', {});
    expect(payload(stale)['stale']).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'alpha' })]));
  });
});

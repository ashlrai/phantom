import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { emptyLedger, type IntentItem, type IntentStatus } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

vi.mock('../src/core/config.js', async (load) => ({
  ...(await load<typeof import('../src/core/config.js')>()),
  loadConfig: () => ({}),
}));
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

async function setup(items: IntentItem[]): Promise<void> {
  root = mkdtempSync(join(tmpdir(), 'intent-native-evidence-'));
  process.env['ASHLR_RUNS_DIR'] = root;
  killed = false;
  await writeLedger({ ...emptyLedger(), items }, root);
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
];

describe('native intent evidence tools', () => {
  it('advertises the three recovered tools as append through the real registry', () => {
    const listed = new Map(listNativeTools().map((tool) => [tool.name, tool]));
    for (const name of ['intent_stale', 'intent_link', 'intent_ship']) {
      expect(nativeToolSafety(name)).toBe('append');
      const schema = listed.get(name)?.inputSchema as { additionalProperties?: boolean; required?: string[] };
      expect(schema?.additionalProperties).toBe(false);
    }
    expect((listed.get('intent_stale')?.inputSchema as { required?: string[] }).required ?? []).toEqual([]);
    expect((listed.get('intent_link')?.inputSchema as { required?: string[] }).required).toEqual(['repo', 'number', 'title']);
    expect((listed.get('intent_ship')?.inputSchema as { required?: string[] }).required).toEqual(['release']);
  });

  it('links a fake merged pull then a fake release, and the ledger reread proves tracking survives', async () => {
    await setup(fixture());
    const linked = await callNativeTool('intent_link', {
      repo: 'example/project', number: 42, title: 'Land RQ-ALPHA-1 and RQ-BETA-1',
      branch: 'feat/rq-alpha-1', url: 'https://example.invalid/pull/42',
    });
    expect(linked.isError).toBeUndefined();
    expect(payload(linked)).toMatchObject({
      ok: true, updated: 2,
      matches: [{ id: 'alpha', status: 'merged' }, { id: 'beta', status: 'verified' }],
    });
    let ledger = await readLedger(root);
    const alpha = ledger.items.find((entry) => entry.id === 'alpha')!;
    expect(alpha.status).toBe('merged');
    expect(alpha.prs).toEqual([{ repo: 'example/project', number: 42, url: 'https://example.invalid/pull/42', state: 'merged' }]);
    expect(alpha.evidence).toEqual([{ at: expect.any(String), kind: 'pr', ref: 'example/project#42' }]);
    const beta = ledger.items.find((entry) => entry.id === 'beta')!;
    expect(beta.status).toBe('verified');
    expect(beta.evidence.at(-1)).toMatchObject({ kind: 'pr', ref: 'example/project#42' });
    expect(ledger.items.find((entry) => entry.id === 'delta')).toEqual(fixture()[3]);

    const shipped = await callNativeTool('intent_ship', {
      release: 'v9.9.9-fake', rq: ['RQ-ALPHA-1', 'RQ-BETA-1'], notes: 'fake notes also name RQ-GAMMA-1',
    });
    expect(shipped.isError).toBeUndefined();
    expect(payload(shipped)).toMatchObject({
      ok: true, updated: 3,
      matches: [
        { id: 'alpha', status: 'shipped' },
        { id: 'beta', status: 'verified' },
        { id: 'gamma', status: 'closed' },
      ],
    });
    ledger = await readLedger(root);
    expect(ledger.items.map((entry) => [entry.id, entry.status])).toEqual([
      ['alpha', 'shipped'], ['beta', 'verified'], ['gamma', 'closed'], ['delta', 'in-progress'], ['epsilon', 'in-progress'],
    ]);
    expect(ledger.items[0]!.evidence.map((row) => row.kind)).toEqual(['pr', 'release']);
    expect(ledger.items[0]!.evidence.at(-1)).toMatchObject({ kind: 'release', ref: 'v9.9.9-fake' });
    expect(ledger.items[2]!.evidence.at(-1)).toMatchObject({ kind: 'release', ref: 'v9.9.9-fake' });
    expect(ledger.items[3]).toEqual(fixture()[3]);
    expect(ledger.items[4]).toEqual(fixture()[4]);
  });

  it('previews stale directives without writes, then apply refreshes tracking without claiming completion', async () => {
    await setup(fixture());
    const path = intentLedgerPath(root);
    const before = readFileSync(path, 'utf8');
    const preview = await callNativeTool('intent_stale', {});
    expect(preview.isError).toBeUndefined();
    const previewPayload = payload(preview);
    expect(previewPayload).toMatchObject({ ok: true, applied: false, updated: 0 });
    expect((previewPayload['stale'] as { id: string; status: string; action: string }[]).map((row) => [row.id, row.status, row.action])).toEqual([
      ['alpha', 'queued', 'requeue'], ['delta', 'in-progress', 'requeue'],
    ]);
    expect(readFileSync(path, 'utf8')).toBe(before);

    const applied = await callNativeTool('intent_stale', { apply: true });
    expect(applied.isError).toBeUndefined();
    const appliedPayload = payload(applied);
    expect(appliedPayload).toMatchObject({ ok: true, applied: true, updated: 2 });
    const appliedRows = appliedPayload['stale'] as { id: string; status: string; action: string }[];
    expect(appliedRows.map((row) => [row.id, row.status])).toEqual([['alpha', 'queued'], ['delta', 'queued']]);
    const ledger = await readLedger(root);
    expect(ledger.items.map((entry) => entry.status)).toEqual(['queued', 'verified', 'closed', 'queued', 'in-progress']);
    for (const id of ['alpha', 'delta']) {
      expect(ledger.items.find((entry) => entry.id === id)!.evidence.at(-1)).toMatchObject({ kind: 'sweep', ref: 'requeue' });
    }
    expect(ledger.items[1]).toEqual(fixture()[1]);
    expect(ledger.items[2]).toEqual(fixture()[2]);
    expect(ledger.items[4]).toEqual(fixture()[4]);
    expect(ledger.items.every((entry) => entry.status !== 'superseded' && entry.closureProposal === null)).toBe(true);
  });

  it('rejects invalid arguments with sanitized errors and never writes', async () => {
    await setup(fixture());
    const path = intentLedgerPath(root);
    const before = readFileSync(path, 'utf8');
    const invalid: [string, unknown][] = [
      ['intent_link', { repo: 'bad', number: 1, title: 'x' }],
      ['intent_link', { repo: 'a/b', number: 1.5, title: 'x' }],
      ['intent_link', { repo: 'a/b', number: 0, title: 'x' }],
      ['intent_link', { repo: 'a/b', number: 1 }],
      ['intent_link', { repo: 'a/b', number: 1, title: 'x', root: '/tmp/elsewhere' }],
      ['intent_link', { repo: 'a/b', number: 1, title: 'x', url: 7 }],
      ['intent_link', 'not-an-object'],
      ['intent_link', null],
      ['intent_ship', { notes: 'no release' }],
      ['intent_ship', { release: 'v1', rq: ['not-an-rq-key'] }],
      ['intent_ship', { release: 'v1', extra: true }],
      ['intent_ship', { release: 'x'.repeat(300) }],
      ['intent_stale', { apply: 'yes' }],
      ['intent_stale', { apply: true, now: '2026-11-09T00:00:00.000Z' }],
      ['intent_stale', [true]],
    ];
    for (const [name, args] of invalid) {
      const result = await callNativeTool(name, args);
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(text(result)).not.toContain('/tmp/elsewhere');
      expect(readFileSync(path, 'utf8')).toBe(before);
    }
  });

  it('fails sanitized on a corrupt ledger and never reports empty success', async () => {
    await setup(fixture());
    const path = intentLedgerPath(root);
    writeFileSync(path, '{corrupt-ledger');
    for (const [name, args] of [
      ['intent_link', { repo: 'a/b', number: 1, title: 'RQ-ALPHA-1' }],
      ['intent_ship', { release: 'v1', rq: ['RQ-ALPHA-1'] }],
      ['intent_stale', { apply: true }],
    ] as const) {
      const result = await callNativeTool(name, args);
      expect(result.isError).toBe(true);
      expect(text(result)).not.toContain('{corrupt-ledger');
      expect(text(result)).toContain('failed');
    }
    expect(readFileSync(path, 'utf8')).toBe('{corrupt-ledger');
  });

  it('kill switch refuses every mutation while arguments still validate first', async () => {
    await setup(fixture());
    const path = intentLedgerPath(root);
    const before = readFileSync(path, 'utf8');
    killed = true;
    for (const [name, args] of [
      ['intent_link', { repo: 'a/b', number: 1, title: 'RQ-ALPHA-1' }],
      ['intent_ship', { release: 'v1', rq: ['RQ-ALPHA-1'] }],
      ['intent_stale', { apply: true }],
      ['intent_stale', {}],
    ] as const) {
      const result = await callNativeTool(name, args);
      expect(result.isError, name).toBe(true);
      expect(text(result)).toContain('kill switch');
    }
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

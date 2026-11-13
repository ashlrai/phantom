/**
 * RQ-PHX-STALEMCPOWNERQUALIFY291S — owner qualification evidence for EXISTING
 * owner PR #5320 (RQ-PHX-INTENTSTALEMCPRESTORE232S), head 89ce21a0dcdf.
 *
 * Complements test/intent-native-stale-preservation-232s.test.ts rather than
 * restating it. Cases pinned here that the owner suite does not cover:
 *   - a fixed fake clock proving staleness is strictly `> staleAfterMs`
 *   - absent-store state: preview AND apply leave a missing runs root missing
 *   - apply preserves provenance, prs and a standing closureProposal verbatim,
 *     including a queued directive whose prior sweep requeue flips the action
 *     to propose-superseded without moving its status
 *   - the apply response shape carries only {ok, stale, applied, updated} and
 *     rows only {id, title, status, action}: an explicit apply never purports
 *     to verify, dispatch or complete work, and merged stays merged
 *   - schema-valid-JSON-but-invalid ledgers fail sanitized, bytes preserved
 *   - foreign keys (root/path/env/cwd/dir/HOME) and non-object/array inputs
 *     refuse before any write and never echo their contents
 *   - loadConfig failure surfaces exactly {error:'Fleet configuration
 *     unavailable'} (the mcp-native.ts list intent_stale was added to)
 *   - the REAL ~/.ashlr/KILL sentinel refuses the append tool (no policy
 *     module mock, so this file stays out of the Tier-1 test lane)
 *
 * Self-skips on trees without the owner change (master before #5320 merges).
 * All repos, RQ keys, paths and timestamps are fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from '../src/core/config.js';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { emptyLedger, type IntentItem, type IntentStatus } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const OWNER_TREE = existsSync(fileURLToPath(new URL('../src/core/intent/native-stale.ts', import.meta.url)));

const NOW = '2026-11-13T12:00:00.000Z';
const OLD = '2026-11-01T00:00:00.000Z';

let root = '';
let previousRunsDir: string | undefined;
let previousHome: string | undefined;

function item(id: string, status: IntentStatus, rq: string[], extra: Partial<IntentItem> = {}): IntentItem {
  return {
    id, title: `Directive ${id}`, source: 'fake note', owner: 'owner', rq, prs: [], status,
    evidence: [], provenance: [], partial: false, closureProposal: null,
    lastTouchedAt: OLD, staleAfterMs: 60_000, createdAt: OLD, updatedAt: OLD, ...extra,
  };
}

async function seed(items: IntentItem[]): Promise<void> {
  await writeLedger({ ...emptyLedger(), items }, root);
}

beforeEach(() => {
  previousRunsDir = process.env['ASHLR_RUNS_DIR'];
  previousHome = process.env['HOME'];
  root = mkdtempSync(join(tmpdir(), 'intent-stale-owner-291s-'));
  process.env['ASHLR_RUNS_DIR'] = root;
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (previousRunsDir === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = previousRunsDir;
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  rmSync(root, { recursive: true, force: true });
  root = '';
});

function text(result: { content: { type: 'text'; text: string }[] }): string {
  return result.content.map((entry) => entry.text).join('\n');
}

function payload(result: { content: { type: 'text'; text: string }[] }): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

type StaleRow = { id: string; title: string; status: string; action: string };

describe.skipIf(!OWNER_TREE)('native intent_stale owner qualification (PR #5320 head 89ce21a0dcdf)', () => {
  it('registers append-only with a description that disclaims close, dispatch, remote verify and completion', () => {
    const tool = listNativeTools().find((entry) => entry.name === 'intent_stale');
    expect(tool).toBeDefined();
    expect(nativeToolSafety('intent_stale')).toBe('append');
    expect(tool!.description).toContain('never close work, dispatch jobs, verify remotely or claim completion');
  });

  it('measures staleness strictly past staleAfterMs at a fixed clock', async () => {
    const window = 60_000;
    await seed([
      item('edge', 'queued', ['RQ-EDGE-1'], {
        lastTouchedAt: new Date(Date.parse(NOW) - window).toISOString(), staleAfterMs: window,
      }),
      item('over', 'queued', ['RQ-OVER-1'], {
        lastTouchedAt: new Date(Date.parse(NOW) - window - 1).toISOString(), staleAfterMs: window,
      }),
      item('terminal-old', 'verified', ['RQ-TERM-1'], { lastTouchedAt: OLD }),
    ]);
    const result = await callNativeTool('intent_stale', {});
    expect(result.isError).not.toBe(true);
    const body = payload(result);
    expect(body).toMatchObject({ ok: true, applied: false, updated: 0 });
    expect((body['stale'] as StaleRow[]).map((row) => row.id)).toEqual(['over']);
  });

  it('preserves ledger bytes on default preview and leaves an absent store absent on preview and apply', async () => {
    await seed([item('a', 'in-progress', ['RQ-A-1'])]);
    const path = intentLedgerPath(root);
    const before = readFileSync(path, 'utf8');
    for (const args of [{}, { apply: false }]) {
      const preview = await callNativeTool('intent_stale', args);
      expect(preview.isError, JSON.stringify(args)).not.toBe(true);
      expect(payload(preview)).toMatchObject({ ok: true, applied: false, updated: 0 });
      expect((payload(preview)['stale'] as StaleRow[]).map((row) => row.id)).toEqual(['a']);
      expect(readFileSync(path, 'utf8')).toBe(before);
    }

    const missing = join(root, 'no-such-store');
    process.env['ASHLR_RUNS_DIR'] = missing;
    try {
      for (const args of [{}, { apply: true }]) {
        const result = await callNativeTool('intent_stale', args);
        expect(result.isError, JSON.stringify(args)).not.toBe(true);
        expect(payload(result)).toMatchObject({
          ok: true, stale: [], applied: (args as { apply?: boolean }).apply === true, updated: 0,
        });
        expect(existsSync(missing)).toBe(false);
      }
    } finally {
      process.env['ASHLR_RUNS_DIR'] = root;
    }
  });

  it('apply refreshes tracking only: statuses, provenance, prs and proposals survive verbatim', async () => {
    const provenance = [{ source: 'note.md', date: '2026-10-01', verbatim: true, partial: false }];
    const prs = [{ repo: 'fake/repo', number: 7, url: 'https://example.invalid/pull/7', state: 'merged' as const }];
    const sweepNote = { at: OLD, kind: 'sweep' as const, ref: 'requeue' };
    await seed([
      item('merged-one', 'merged', ['RQ-MERGED-1'], { provenance, prs }),
      item('closed-one', 'closed', ['RQ-CLOSED-1'], { provenance }),
      item('prop', 'proposed', ['RQ-PROP-1'], { closureProposal: 'superseded' }),
      item('requeued', 'queued', ['RQ-REQUE-1'], { evidence: [sweepNote], provenance }),
      item('live', 'in-progress', ['RQ-LIVE-1']),
    ]);
    const before = await readLedger(root);

    const applied = await callNativeTool('intent_stale', { apply: true });
    expect(applied.isError).not.toBe(true);
    const body = payload(applied);

    // The whole result is exactly four fields; every row is exactly four.
    // Nothing here can purport to verify, dispatch or close anything.
    expect(Object.keys(body).sort()).toEqual(['applied', 'ok', 'stale', 'updated']);
    for (const row of body['stale'] as Record<string, unknown>[]) {
      expect(Object.keys(row).sort()).toEqual(['action', 'id', 'status', 'title']);
    }
    expect(body).toMatchObject({ ok: true, applied: true, updated: 4 });
    const rows = new Map((body['stale'] as StaleRow[]).map((row) => [row.id, row]));
    expect(rows.get('merged-one')).toMatchObject({ status: 'merged', action: 'await-verification' });
    expect(rows.get('prop')).toMatchObject({ status: 'proposed', action: 'propose-superseded' });
    expect(rows.get('requeued')).toMatchObject({ status: 'queued', action: 'propose-superseded' });
    expect(rows.get('live')).toMatchObject({ status: 'queued', action: 'requeue' });
    expect(rows.has('closed-one')).toBe(false);

    const ledger = await readLedger(root);
    const byId = new Map(ledger.items.map((entry) => [entry.id, entry]));
    const beforeId = new Map(before.items.map((entry) => [entry.id, entry]));

    // Merged remains merged: await-verification is a recommendation, not a claim.
    const merged = byId.get('merged-one')!;
    expect(merged.status).toBe('merged');
    expect(merged.closureProposal).toBeNull();
    expect(merged.provenance).toEqual(provenance);
    expect(merged.prs).toEqual(prs);
    expect(merged.evidence.at(-1)).toEqual({
      at: NOW, kind: 'sweep', ref: 'await-verification',
      note: 'Local stale tracking refreshed; no job dispatched.',
    });
    expect(merged.lastTouchedAt).toBe(NOW);
    expect(merged.updatedAt).toBe(NOW);
    expect(merged.createdAt).toBe(OLD);

    // Terminal entries are byte-identical, provenance included.
    expect(byId.get('closed-one')).toEqual(beforeId.get('closed-one'));

    // A standing superseded proposal is preserved, never applied.
    const prop = byId.get('prop')!;
    expect(prop.status).toBe('proposed');
    expect(prop.closureProposal).toBe('superseded');
    expect(prop.evidence.at(-1)).toMatchObject({ kind: 'sweep', ref: 'propose-superseded', at: NOW });

    // Prior requeue evidence flips the action label without moving the status.
    const requeued = byId.get('requeued')!;
    expect(requeued.status).toBe('queued');
    expect(requeued.provenance).toEqual(provenance);
    expect(requeued.evidence.map((row) => row.ref)).toEqual(['requeue', 'propose-superseded']);

    // No job/claim/outcome closure: no item added or dropped, no terminal
    // status created, no proposal consumed, and the runs root holds only the
    // ledger file — no dispatch or claim artifact.
    expect(ledger.items.map((entry) => entry.id)).toEqual(before.items.map((entry) => entry.id));
    for (const entry of ledger.items) {
      expect(entry.closureProposal).toEqual(beforeId.get(entry.id)!.closureProposal);
    }
    expect(ledger.items.filter((entry) => ['shipped', 'verified', 'closed', 'superseded'].includes(entry.status))
      .map((entry) => entry.id)).toEqual(['closed-one']);
    expect(readdirSync(root).sort()).toEqual(['intent']);
    expect(readdirSync(join(root, 'intent')).sort()).toEqual(['ledger.json']);
  });

  it('makes a repeat apply at the same fixed clock a byte-identical no-op', async () => {
    await seed([item('a', 'in-progress', ['RQ-A-1']), item('m', 'merged', ['RQ-M-1'])]);
    expect((await callNativeTool('intent_stale', { apply: true })).isError).not.toBe(true);
    const after = readFileSync(intentLedgerPath(root), 'utf8');
    const again = await callNativeTool('intent_stale', { apply: true });
    expect(again.isError).not.toBe(true);
    expect(payload(again)).toMatchObject({ ok: true, applied: true, updated: 0, stale: [] });
    expect(readFileSync(intentLedgerPath(root), 'utf8')).toBe(after);
    const preview = await callNativeTool('intent_stale', {});
    expect(payload(preview)).toMatchObject({ ok: true, applied: false, updated: 0, stale: [] });
  });

  it('refuses non-boolean apply, foreign keys and non-object inputs without writes or echo', async () => {
    await seed([item('a', 'in-progress', ['RQ-A-1'])]);
    const path = intentLedgerPath(root);
    const before = readFileSync(path, 'utf8');
    const marker = '/tmp/STALE-OWNER-291S-DO-NOT-ECHO';
    const invalid: unknown[] = [
      { apply: 'true' }, { apply: 'false' }, { apply: 0 }, { apply: {} }, { apply: [] },
      { apply: true, root: marker }, { apply: true, path: marker }, { apply: true, cwd: marker },
      { apply: true, dir: marker }, { apply: true, env: { PATH: marker } }, { apply: true, HOME: marker },
      { root: marker },
      [], ['apply'], [{ apply: true }], 0, 42, true, 'apply', '', null, undefined,
    ];
    for (const args of invalid) {
      const result = await callNativeTool('intent_stale', args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(text(result)).toContain('Invalid arguments for intent_stale');
      expect(text(result)).not.toContain(marker);
      expect(readFileSync(path, 'utf8')).toBe(before);
    }
  });

  it('fails sanitized on schema-invalid ledger JSON and preserves the bytes', async () => {
    await seed([item('a', 'in-progress', ['RQ-A-1'])]);
    const path = intentLedgerPath(root);
    for (const bad of [
      '{"schema":"ashlr.intent-ledger/v0","items":[]}',
      '{"schema":"ashlr.intent-ledger/v1","items":[{"id":7}]}',
      '[]',
      '42',
    ]) {
      writeFileSync(path, bad);
      for (const args of [{}, { apply: true }]) {
        const result = await callNativeTool('intent_stale', args);
        expect(result.isError, `${bad} ${JSON.stringify(args)}`).toBe(true);
        expect(payload(result)).toEqual({ error: 'Intent stale sweep could not run.' });
        expect(text(result)).not.toContain('ashlr.intent-ledger/v0');
      }
      expect(readFileSync(path, 'utf8')).toBe(bad);
    }
  });

  it('surfaces only Fleet configuration unavailable when the config load fails', async () => {
    await seed([item('a', 'in-progress', ['RQ-A-1'])]);
    const before = readFileSync(intentLedgerPath(root), 'utf8');
    vi.spyOn(config, 'loadConfig').mockImplementation(() => {
      throw new Error('could not read /private/STALE-OWNER-291S/config.json: EACCES');
    });
    for (const args of [{}, { apply: true }]) {
      const result = await callNativeTool('intent_stale', args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(payload(result)).toEqual({ error: 'Fleet configuration unavailable' });
      expect(text(result)).not.toContain('STALE-OWNER-291S');
      expect(text(result)).not.toContain('EACCES');
      expect(readFileSync(intentLedgerPath(root), 'utf8')).toBe(before);
    }
  });

  it('is refused by the real ~/.ashlr/KILL sentinel while arguments still validate first', async () => {
    await seed([item('a', 'in-progress', ['RQ-A-1'])]);
    const before = readFileSync(intentLedgerPath(root), 'utf8');
    const home = join(root, 'home');
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(join(home, '.ashlr', 'KILL'), 'kill switch active\n', { mode: 0o600 });
    process.env['HOME'] = home;
    try {
      for (const args of [{ apply: true }, {}]) {
        const result = await callNativeTool('intent_stale', args);
        expect(result.isError, JSON.stringify(args)).toBe(true);
        expect(text(result)).toContain('kill switch');
      }
      const invalid = await callNativeTool('intent_stale', { apply: 'yes' });
      expect(invalid.isError).toBe(true);
      expect(text(invalid)).toContain('Invalid arguments for intent_stale');
      expect(readFileSync(intentLedgerPath(root), 'utf8')).toBe(before);
    } finally {
      if (previousHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previousHome;
    }
  });
});

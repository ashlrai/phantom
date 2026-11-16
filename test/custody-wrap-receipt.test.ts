/**
 * Custody step 2 (design-custody-fleet.md 3.2): a dispatch's spawn custody
 * reaches its receipt as secrets.wrap, and a task tagged needs-secrets never
 * spawns unwrapped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig, EngineCommand } from '../src/core/types.js';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import type { PhantomCustodyRecord } from '../src/core/run/phantom-custody.js';

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFileSync: vi.fn(() => Buffer.from('/usr/local/bin/phantom')),
}));

const { spawnEngine } = await import('../src/core/run/engines.js');
const cap = await import('../src/core/run/custody-capture.js');
const { receiptBodyFromDispatchEvent } = await import('../src/core/receipt/receipt-dispatch.js');
const { isReceiptV1Body } = await import('../src/core/receipt/receipt-v1.js');

function cfg(enabled: boolean): AshlrConfig {
  return {
    version: 1, roots: ['/tmp'], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: ['ollama'] },
    telemetry: {}, tools: {}, phantom: { enabled },
  } as unknown as AshlrConfig;
}
const W = (engine = 'x'): PhantomCustodyRecord => ({ wrapped: true, engine, preflight_schema: 1, preflight_exit: 0 });
const U = (reason: 'phantom-disabled' | 'worktree-namespace', engine = 'x'): PhantomCustodyRecord =>
  ({ wrapped: false, reason, engine, preflight_schema: 1, preflight_exit: null });

const quiet = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

describe('custody capture (pure)', () => {
  it('receiptWrapFromCustody: none -> null, all wrapped -> wrapped, any unwrapped -> first reason', () => {
    expect(cap.receiptWrapFromCustody([])).toBeNull();
    expect(cap.receiptWrapFromCustody([W(), W()])).toEqual({ wrapped: true, reason: null });
    expect(cap.receiptWrapFromCustody([W(), U('worktree-namespace'), U('phantom-disabled')])).toEqual({ wrapped: false, reason: 'worktree-namespace' });
  });

  it('keeps a late unwrapped spawn after the record cap, so the receipt cannot say wrapped', async () => {
    const records = await cap.runWithCustodyCapture({ requireWrap: false }, async (c) => {
      for (let i = 0; i < 70; i++) cap.noteSpawnCustody(W(`w${i}`));
      cap.noteSpawnCustody(U('worktree-namespace', 'late'));
      cap.noteSpawnCustody(U('phantom-disabled', 'later'));
      return c.records;
    });
    expect(records).toHaveLength(64);
    expect(records.filter((r) => !r.wrapped).map((r) => r.engine)).toEqual(['late']);
    expect(cap.receiptWrapFromCustody(records)).toEqual({ wrapped: false, reason: 'worktree-namespace' });
  });

  it('itemNeedsSecrets reads only the exact needs-secrets tag', () => {
    expect(cap.itemNeedsSecrets({ tags: ['needs-secrets'] })).toBe(true);
    expect(cap.itemNeedsSecrets({ tags: ['secrets', 'Needs-Secrets'] })).toBe(false);
    expect(cap.itemNeedsSecrets({ tags: [] })).toBe(false);
    expect(cap.itemNeedsSecrets({})).toBe(false);
  });

  it('scopes are isolated across concurrent dispatches and absent outside a scope', async () => {
    cap.noteSpawnCustody(W('outside'));
    expect(cap.custodyRequiresWrap()).toBe(false);
    const [a, b] = await Promise.all([
      cap.runWithCustodyCapture({ requireWrap: true }, async (c) => {
        await new Promise((r) => setTimeout(r, 5));
        cap.noteSpawnCustody(W('a'));
        expect(cap.custodyRequiresWrap()).toBe(true);
        return c.records;
      }),
      cap.runWithCustodyCapture({ requireWrap: false }, async (c) => {
        cap.noteSpawnCustody(U('phantom-disabled', 'b'));
        expect(cap.custodyRequiresWrap()).toBe(false);
        return c.records;
      }),
    ]);
    expect(a.map((r) => r.engine)).toEqual(['a']);
    expect(b.map((r) => r.engine)).toEqual(['b']);
  });
});

describe('receipt secrets.wrap', () => {
  const ev = (): DispatchProductionEvent => ({
    schemaVersion: 1, ts: '2026-10-25T06:30:00.000Z', itemId: 'item-1', source: 'backlog' as DispatchProductionEvent['source'],
    repo: 'ashlrai/phantom', title: 't', backend: 'codex' as DispatchProductionEvent['backend'], tier: null,
    assignedBy: 'router', routeReason: 'r', outcome: 'proposal-created', proposalCreated: true,
    runId: 'run-wrap-1', spentUsd: 0, basis: 'live' as DispatchProductionEvent['basis'],
  });
  it('defaults to null and carries a captured wrap into a valid receipt body', () => {
    expect(receiptBodyFromDispatchEvent(ev())!.secrets.wrap).toBeNull();
    const w = receiptBodyFromDispatchEvent(ev(), { wrapped: true, reason: null })!;
    expect(w.secrets.wrap).toEqual({ wrapped: true, reason: null });
    expect(isReceiptV1Body(w)).toBe(true);
    const u = receiptBodyFromDispatchEvent(ev(), cap.receiptWrapFromCustody([U('worktree-namespace')]))!;
    expect(u.secrets.wrap).toEqual({ wrapped: false, reason: 'worktree-namespace' });
  });
});

describe('spawnEngine inside a capture scope', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'custody-wrap-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  const touch = (): EngineCommand => ({ bin: 'touch', args: [join(dir, 'ran')], cwd: dir });

  it('records the spawn decision in the scope', async () => {
    quiet();
    const records = await cap.runWithCustodyCapture({ requireWrap: false }, async (c) => {
      await spawnEngine(touch(), cfg(false), { timeoutMs: 5_000 });
      return c.records;
    });
    expect(records).toEqual([{ wrapped: false, reason: 'phantom-disabled', engine: 'touch', preflight_schema: 1, preflight_exit: null }]);
    expect(existsSync(join(dir, 'ran'))).toBe(true);
  });

  it('needs-secrets + unwrapped: held before the child starts, reason named', async () => {
    quiet();
    const r = await cap.runWithCustodyCapture({ requireWrap: true }, () => spawnEngine(touch(), cfg(false), { timeoutMs: 5_000 }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('held: task needs secrets');
    expect(r.error).toContain('phantom-disabled');
    expect(existsSync(join(dir, 'ran'))).toBe(false);
  });

  it('needs-secrets + wrapped: not held (spawn proceeds via phantom exec)', async () => {
    quiet();
    writeFileSync(join(dir, '.phantom.toml'), '[phantom]\n');
    mkdirSync(join(dir, '.git'));
    const out = await cap.runWithCustodyCapture({ requireWrap: true }, async (c) => ({
      r: await spawnEngine({ bin: 'nonexistent-engine-wrap-test', args: [], cwd: dir }, cfg(true), { timeoutMs: 5_000 }),
      records: c.records,
    }));
    expect(out.records[0]).toMatchObject({ wrapped: true });
    expect(out.r.error ?? '').not.toContain('held:');
  });
});

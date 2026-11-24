import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetClaimBind } from '../src/cli/fleet-claim-bind.js';
import { claimNoticePassDeps } from '../src/cli/fleet-claim-notices.js';
import { claimNoticePaths, readClaimThreadBindings, readClaimThreadBindingsState,
  runClaimNoticePass } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding, validateClaimThreadKey,
  CLAIM_THREAD_BINDINGS_MAX_PAIRS } from '../src/core/fleet/claim-thread-binding-write.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const now = Date.parse('2026-11-15T12:00:00Z');
const colonThread = 'slack:T0FAKE001:C0FAKE001:1700000000.000100';
const slashThread = 'T0FAKE001/C0FAKE001/1700000000.000200';

describe('fleet claim-bind (443c)', () => {
  let root: string;
  const bindings = () => claimNoticePaths(root).bindings;
  const bind = (args: string[]) => cmdFleetClaimBind(args, { runsRoot: root, now: () => now });
  const lastJson = () => JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0])) as Record<string, unknown>;

  beforeEach(() => {
    root = join(mkdtempSync(join(tmpdir(), 'claim-bind-443c-')), 'runs');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  it('accepts exactly the two sender grammars', () => {
    expect(validateClaimThreadKey(colonThread)).toBe(true);
    expect(validateClaimThreadKey(slashThread)).toBe(true);
    for (const bad of ['', 'slack:T0FAKE001:C0FAKE001', 'slack:t0fake:C0FAKE001:1.2', 'T0FAKE001/C0FAKE001',
      'T0FAKE001/C0FAKE001/notats', 'https://fake.slack.com/archives/C0FAKE001/p1700000000000100',
      `slack:T0FAKE001:C0FAKE001:1700000000.000100:extra`]) {
      expect(validateClaimThreadKey(bad), bad).toBe(false);
    }
  });

  it('writes rows the real reader returns, in both grammars, at mode 0600', async () => {
    expect(await bind(['c1', '--repo', 'acme/app', '--thread', colonThread, '--json'])).toBe(0);
    expect(lastJson()).toEqual({ status: 'bound', claimId: 'c1', repo: 'acme/app', threadKey: colonThread });
    expect(await bind(['c2', '--repo', 'acme/app', '--thread', slashThread, '--pr', '42', '--head', 'abc123'])).toBe(0);
    expect(readClaimThreadBindings(bindings())).toEqual([
      { claimId: 'c1', repo: 'acme/app', threadKey: colonThread },
      { claimId: 'c2', repo: 'acme/app', threadKey: slashThread, pr: 42, head: 'abc123' },
    ]);
    expect(statSync(bindings()).mode & 0o777).toBe(0o600);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it('a rebind wins and an identical bind is unchanged', async () => {
    expect(await bind(['c1', '--repo', 'acme/app', '--thread', colonThread])).toBe(0);
    expect(await bind(['c1', '--repo', 'acme/app', '--thread', slashThread, '--json'])).toBe(0);
    expect(lastJson()).toMatchObject({ status: 'rebound', threadKey: slashThread });
    const before = readFileSync(bindings(), 'utf8');
    expect(await bind(['c1', '--repo', 'acme/app', '--thread', slashThread, '--json'])).toBe(0);
    expect(lastJson()).toMatchObject({ status: 'unchanged' });
    expect(readFileSync(bindings(), 'utf8')).toBe(before);
    expect(readClaimThreadBindings(bindings())).toEqual([{ claimId: 'c1', repo: 'acme/app', threadKey: slashThread }]);
  });

  it.each([
    ['bad thread', ['c1', '--repo', 'acme/app', '--thread', 'C0FAKE001']],
    ['bad repo', ['c1', '--repo', 'acme', '--thread', colonThread]],
    ['bad claimId', ['has space', '--repo', 'acme/app', '--thread', colonThread]],
    ['long claimId', ['x'.repeat(129), '--repo', 'acme/app', '--thread', colonThread]],
    ['bad pr', ['c1', '--repo', 'acme/app', '--thread', colonThread, '--pr', '-1']],
    ['missing thread', ['c1', '--repo', 'acme/app']],
    ['two ids', ['c1', 'c2', '--repo', 'acme/app', '--thread', colonThread]],
    ['unknown flag', ['c1', '--repo', 'acme/app', '--thread', colonThread, '--force', 'x']],
  ])('%s exits 2 and writes nothing', async (_name, args) => {
    expect(await bind(args)).toBe(2);
    expect(existsSync(bindings())).toBe(false);
  });

  it('--help exits 0 without writing', async () => {
    expect(await bind(['--help'])).toBe(0);
    expect(existsSync(root)).toBe(false);
  });

  it('refuses (exit 1) a new pair at capacity and an over-budget file, never throwing', async () => {
    const full = Array.from({ length: CLAIM_THREAD_BINDINGS_MAX_PAIRS }, (_, i) =>
      JSON.stringify({ v: 1, claimId: `f${i}`, repo: 'acme/app', threadKey: colonThread })).join('\n') + '\n';
    expect(appendClaimThreadBinding(bindings(), { claimId: 'seed', repo: 'acme/app', threadKey: colonThread }, now).ok)
      .toBe(true);
    writeFileSync(bindings(), full, { mode: 0o600 });
    expect(await bind(['c-new', '--repo', 'acme/app', '--thread', colonThread, '--json'])).toBe(1);
    expect(lastJson()).toMatchObject({ status: 'refused', reason: 'bindings-at-capacity' });
    // Rebinding an existing pair is still allowed at capacity.
    expect(await bind(['f0', '--repo', 'acme/app', '--thread', slashThread])).toBe(0);
    writeFileSync(bindings(), 'x'.repeat(4 * 1024 * 1024 + 1), { mode: 0o600 });
    expect(appendClaimThreadBinding(bindings(), { claimId: 'c1', repo: 'acme/app', threadKey: colonThread }, now))
      .toEqual({ ok: false, kind: 'refused', reason: 'bindings-over-budget' });
  });

  it('starts a fresh line after a torn trailing row and requires repair before reading bindings', () => {
    appendClaimThreadBinding(bindings(), { claimId: 'seed', repo: 'acme/app', threadKey: colonThread }, now);
    const torn = '{"v":1,"claimId":"torn';
    writeFileSync(bindings(), torn, { mode: 0o600 });
    expect(appendClaimThreadBinding(bindings(), { claimId: 'c1', repo: 'acme/app', threadKey: colonThread }, now))
      .toMatchObject({ ok: true, status: 'bound' });
    const raw = readFileSync(bindings(), 'utf8');
    expect(raw.startsWith(`${torn}\n`)).toBe(true);
    const recovered = raw.slice(torn.length + 1);
    expect(JSON.parse(recovered)).toEqual({ v: 1, claimId: 'c1', repo: 'acme/app', threadKey: colonThread, at: now });
    expect(readClaimThreadBindingsState(bindings())).toBeNull();
    expect(readClaimThreadBindings(bindings())).toEqual([]);
    writeFileSync(bindings(), recovered, { mode: 0o600 });
    expect(readClaimThreadBindings(bindings())).toEqual([{ claimId: 'c1', repo: 'acme/app', threadKey: colonThread }]);
  });

  describe('end to end through runClaimNoticePass', () => {
    const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known', messages: [], proposals: [],
      expiredClaims: 0, claims: [{ id: 'c1', repo: 'acme/app', task: 'fake task', agent: 'fake-owner',
        claimedAt: now - 1000, expiresAt: now + 3_600_000 }] };
    const pass = (send: ReturnType<typeof vi.fn>) => runClaimNoticePass(claimNoticePassDeps({
      runsRoot: root, readBoard: () => board, now: () => now, send,
      readPrevSnapshot: () => ({ state: 'known', claims: [], messages: [], asOf: 0 }),
    }));

    it('a bound claim sends one ASSIGNED notice into its thread', async () => {
      expect(await bind(['c1', '--repo', 'acme/app', '--thread', colonThread])).toBe(0);
      const send = vi.fn().mockReturnValue({ ok: true, receipt: 'fake-receipt' });
      const result = await pass(send);
      expect(result).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0 });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]).toBe(colonThread);
      expect(result.deliveries[0]).toMatchObject({ state: 'ASSIGNED', threadKey: colonThread, result: 'sent' });
    });

    it('without a bind nothing is sent', async () => {
      const send = vi.fn().mockReturnValue({ ok: true });
      const result = await pass(send);
      expect(result).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
      expect(send).not.toHaveBeenCalled();
    });
  });
});

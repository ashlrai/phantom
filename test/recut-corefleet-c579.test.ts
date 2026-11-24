import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass } from '../src/core/fleet/claim-notice-send.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimFleetWork, postFleetMessage, readFleetBoard } from '../src/core/fleet/coordination.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('recut C579 retains an entire real claim batch through a torn corrected route and a restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recut-corefleet-c579-'));
  chmodSync(root, 0o700);
  roots.push(root);
  const ledgerPath = join(root, 'coordination.jsonl');
  const runsRoot = join(root, 'runs');
  const paths = claimNoticePaths(runsRoot);
  let now = Date.parse('2026-11-18T12:00:00Z');
  const deliveries: string[] = [];
  // Rebuild all file dependencies on every pass to exercise durable recovery.
  const pass = () => runClaimNoticePass({
    ...claimNoticeFileDeps(runsRoot),
    readBoard: () => readFleetBoard({ path: ledgerPath, now }),
    now: () => now,
    send: thread => { deliveries.push(thread); return { ok: true, receipt: 'fake-receipt' }; },
  });
  expect(postFleetMessage({ from: 'fake-setup', to: 'all', body: 'fake baseline', ttlMs: 1 },
    { path: ledgerPath, now })).toMatchObject({ ok: true });
  expect(await pass()).toMatchObject({ status: 'completed', baselined: true, sent: 0 });
  now += 1_000;
  const bindings = ['first', 'second'].map((label, index) => {
    const made = claimFleetWork({ repo: 'fake/project', task: `fake ${label} task`, agent: `fake-${label}` },
      { path: ledgerPath, now });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error('fake claim creation failed');
    const binding = { claimId: made.value.claim.id, repo: 'fake/project',
      threadKey: `T000FAKE/C000FAKE/1700000000.00000${index + 1}` };
    expect(appendClaimThreadBinding(paths.bindings, binding, now)).toMatchObject({ ok: true });
    return binding;
  });
  const original = readFileSync(paths.bindings, 'utf8');
  const corrected = { v: 1, ...bindings[1]!, threadKey: 'T000FAKE/C000FAKE/1700000000.000003' };
  const damaged = `${original}${JSON.stringify(corrected).slice(0, -1)}\n`;
  writeFileSync(paths.bindings, damaged, { mode: 0o600 });
  const previous = readFileSync(paths.prev);
  for (let restart = 0; restart < 2; restart++) {
    now += 1_000;
    expect(await pass()).toMatchObject({ status: 'bindings-unavailable', planned: 0, sent: 0, deliveries: [] });
    expect(deliveries).toEqual([]);
    expect(readFileSync(paths.prev)).toEqual(previous);
    expect(existsSync(paths.sent)).toBe(false);
    expect(readFileSync(paths.bindings, 'utf8')).toBe(damaged);
  }
  writeFileSync(paths.bindings, `${original}${JSON.stringify(corrected)}\n`, { mode: 0o600 });
  now += 1_000;
  expect(await pass()).toMatchObject({ status: 'completed', planned: 2, sent: 2, failed: 0 });
  expect(deliveries).toEqual([bindings[0]!.threadKey, corrected.threadKey]);
  const keys = readFileSync(paths.sent, 'utf8').trim().split('\n')
    .map(line => (JSON.parse(line) as { key: string }).key);
  expect(new Set(keys).size).toBe(2);
  expect(JSON.parse(readFileSync(paths.prev, 'utf8')).claims).toHaveLength(2);
  now += 1_000;
  expect(await pass()).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
  expect(deliveries).toEqual([bindings[0]!.threadKey, corrected.threadKey]);
  expect(readFileSync(paths.sent, 'utf8').trim().split('\n')).toHaveLength(2);
});

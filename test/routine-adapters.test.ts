import { afterEach, beforeEach, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runRoutinesCli } from '../src/cli/routines.js';
import { grokbotAdapter, routineAdapter, rebalanceRoutines, importRoutines, readRoutines,
  rebalanceSavedRoutines, GROKBOT_NEXT_RESET, type Routine, type RoutineProbe } from '../src/core/automations/routines.js';
import { isolateAshlrHome } from './helpers/automations-fakes.js';
import { ashlrHome } from '../src/core/cloud/store.js';
let restore: () => void;
beforeEach(() => { restore = isolateAshlrHome(); });
afterEach(() => restore());
const row: Routine = { id: 'morning-summary', schedule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
  prompt: 'Summarize engineering progress.', capabilities: ['report'], last_ledger_state: null };
const document = (routines: Routine[]) => ({ schema: 'phantom-routines.v1', routines });
const probe = (at: string, cost = 0): RoutineProbe => ({ health: 'ready', quota_state: 'available',
  reset_at: null, observed_at: at, expires_at: new Date(Date.parse(at) + 300_000).toISOString(), cost, capabilities: ['report'] });
it('moves codex → grokbot after November 1 reset → codex on fresh exhaustion', async () => {
  const before = '2026-10-31T23:59:00.000Z', after = '2026-11-01T00:00:01.000Z';
  let evidence = { ...probe(before), quota_state: 'exhausted' as RoutineProbe['quota_state'], reset_at: GROKBOT_NEXT_RESET };
  const grok = grokbotAdapter(async () => evidence);
  let codexTime = before;
  const codex = routineAdapter('codex', async () => probe(codexTime, 1));
  await importRoutines(document([row]));
  expect((await rebalanceSavedRoutines([codex, grok], new Date(before)))[0]!.last_ledger_state!.provider).toBe('codex');
  codexTime = after;
  // Crossing reset alone never manufactures quota.
  expect((await rebalanceSavedRoutines([codex, grok], new Date(after)))[0]!.last_ledger_state!.provider).toBe('codex');
  evidence.quota_state = 'available'; // Pre-reset availability is also insufficient after reset.
  expect((await rebalanceSavedRoutines([codex, grok], new Date(after)))[0]!.last_ledger_state!.provider).toBe('codex');
  evidence = { ...probe(after), reset_at: GROKBOT_NEXT_RESET };
  expect((await rebalanceSavedRoutines([codex, grok], new Date(after)))[0]!.last_ledger_state!.provider).toBe('grokbot');
  evidence.quota_state = 'exhausted';
  expect((await rebalanceSavedRoutines([codex, grok], new Date(after)))[0]!.last_ledger_state!.provider).toBe('codex');
});
it.each(['low', 'unhealthy', 'stale', 'capability', 'throws', 'invalid-cost'] as const)('excludes %s evidence and records unavailable placement', async kind => {
  const at = '2026-11-01T00:00:01.000Z', evidence = probe(at);
  if (kind === 'low') evidence.quota_state = 'low';
  if (kind === 'unhealthy') evidence.health = 'unhealthy';
  if (kind === 'stale') evidence.expires_at = at;
  if (kind === 'capability') evidence.capabilities = [];
  if (kind === 'invalid-cost') evidence.cost = -1;
  const adapter = routineAdapter('local', async () => { if (kind === 'throws') throw new Error('private detail'); return evidence; });
  const result = await rebalanceRoutines([row], [adapter], new Date(at));
  expect(result[0]!.last_ledger_state).toEqual({ provider: null, at, reason: 'unavailable' });
});
it('CLI imports and exports portable ledger state, rejects conflicts atomically, and rebalances all rows', async () => {
  const path = join(ashlrHome(), 'transfer.json'), lines: string[] = [];
  await importRoutines(document([row, { ...row, id: 'nightly-summary' }]));
  await importRoutines(document([row, { ...row, id: 'nightly-summary' }])); // Key order on disk is canonical.
  const at = new Date().toISOString();
  await writeFile(join(ashlrHome(), 'routines', 'providers.json'), JSON.stringify({ grokbot: probe(at), devin: probe(at, 2) }));
  expect(await runRoutinesCli(['rebalance'], s => lines.push(s))).toBe(0);
  const saved = await readRoutines();
  expect(saved).toHaveLength(2);
  expect(saved.every(r => r.last_ledger_state!.provider === 'grokbot')).toBe(true);
  expect(await runRoutinesCli(['export'], s => lines.push(s))).toBe(0);
  expect(JSON.parse(lines.at(-1)!)).toEqual(document(saved));
  await writeFile(path, lines.at(-1)!);
  expect(await runRoutinesCli(['import', path], () => {})).toBe(0);
  await expect(importRoutines(document([{ ...row, id: 'another' }, { ...row, prompt: 'Conflict' }]))).rejects.toThrow('conflict');
  expect(await readRoutines()).toEqual(saved);
  expect(await runRoutinesCli(['export', 'unexpected'], () => {}, () => {})).toBe(2);
});
it('rejects malformed schedules, duplicate IDs, and credential-bearing payloads', async () => {
  for (const rows of [[{ ...row, schedule: 'bad' }], [row, row], [{ ...row, prompt: 'password=do-not-import' }]]) {
    await expect(importRoutines(document(rows))).rejects.toThrow();
  }
  expect(await readRoutines()).toEqual([]);
});

it('Grok Bot supplies the November reset when a collector omits its bootstrap date', async () => {
  const at = '2026-10-31T23:59:00.000Z';
  const { reset_at: _reset, ...evidence } = probe(at);
  expect((await grokbotAdapter(async () => evidence).probe(new Date(at))).reset_at).toBe(GROKBOT_NEXT_RESET);
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEmptyFamilies, runEmptyApplyTick, undoEmptyFamily, readyJobs, EMPTY_APPLY_SCHEMA } from '../src/core/fleet/empty-family-apply.js';
import { cmdJobs } from '../src/cli/jobs-empty.js';
import { summarizeEmptyFamilies } from '../src/core/fleet/empty-families.js';
import { briefFamilyYield } from '../src/core/fleet/leader-compact-brief.js';
import { familyAutoStop } from '../src/core/fleet/family-auto-stop.js';

const now = Date.parse('2026-11-19T12:00:00Z');
const HOUR = 3600;
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'empty-apply-')); await mkdir(join(dir, 'queue')); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

const launches = (ids: string[], lane: string, reason: string) => ids.map(id => ({ id, lane, empty: true, reason }));
const report = summarizeEmptyFamilies([
  ...launches([1, 2, 3, 4, 5].map(n => `RQ-MD${n}A11180${n}Q8`), 'devin-flash', 'already-on-master'),
  ...launches([1, 2, 3].map(n => `RQ-LOGIN${n}`), 'cursor', 'auth_failed'),
  ...launches([1, 2, 3, 4, 5].map(n => `FIXUP-CI-fixer-${n}`), 'claude', 'already-on-master'),
  ...launches([1, 2, 3, 4, 5].map(n => `RQ-RELEASE-WATCH${n}`), 'claude', 'already-on-master'),
], 24);
const readReport = async () => report;
const queue = [
  '- READY RQ-MD6A111806Q8 (P2, pool=devin-flash, tier=fast, repo=ashlr-md)',
  '- READY RQ-MD7A111807Q8 (P2, tier=fast, repo=ashlr-md)',
  '- READY RQ-MD8A111808Q8 (P2, pool=codex-cmp, tier=fast, repo=ashlr-md)',
  '- CLAIMED RQ-MD9A111809Q8',
  '- READY RQ-LOGIN4 (P1, pool=cursor)',
  '- READY FIXUP-CI-fixer-6 (P0, pool=claude)',
  '- READY RQ-RELEASE-WATCH6 (P1, pool=claude)',
].join('\n') + '\n';
const put = (name: string, text: string) => writeFile(join(dir, 'queue', name), text);
/** A reroute hint an older version wrote: still expires and still undoes. */
const seedHint = async (until: number) => {
  await put('lane-avoid.tsv', `cursor\tRQ-LOGIN*\t${until}\t3of3-empty_auth_failed\n`);
  await put('empty-family-actions.json', JSON.stringify({ schema: 'jobs.empty.actions.v1', last_run_ms: null, entries: [{ family: 'RQ-LOGIN*', lane: 'cursor', action: 'reroute', ids: [], until, reason: '3of3-empty_auth_failed' }] }));
};
const get = (name: string) => readFile(join(dir, 'queue', name), 'utf8').catch(() => null);

const familyLedger = (prefix = 'RQ-PHX-FLEETCLAIMSGREEN', count = 12) => Array.from({ length: count }, (_, i) =>
  [{ event: 'launch', job: `${prefix}${750 + i}`, ts: new Date(now).toISOString() }, { event: 'finish', job: `${prefix}${750 + i}`, ts: new Date(now).toISOString(), empty: true }]).flat();
const familyPlan = (rows: object[]) => familyAutoStop(briefFamilyYield(rows.map(r => JSON.stringify(r)).join('\n'), now), now);
it('proposes a twelve-hour stop using the brief family ERE, matching only that family', () => {
  const rows = familyPlan(familyLedger());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ family: 'RQ-PHX-FLEETCLAIMSGREEN*', until: now / 1000 + 12 * HOUR });
  const pattern = new RegExp(rows[0]!.pattern);
  expect(pattern.test('RQ-PHX-FLEETCLAIMSGREEN752')).toBe(true);
  for (const id of ['RQ-PHX-INGESTCONTRACTFINISH754S', 'RQ-PHX-FLEETCLAIMSGREEN752S', 'other-RQ-PHX-FLEETCLAIMSGREEN752']) expect(pattern.test(id)).toBe(false);
});
it('requires three empties, zero PRs and zero merges in the brief window; protects leader, fixup and guardian work', () => {
  expect(familyPlan(familyLedger('work', 2))).toEqual([]);
  expect(familyPlan(familyLedger('work', 3))).toHaveLength(1);
  expect(familyPlan([...familyLedger(), { event: 'merged', job: 'RQ-PHX-FLEETCLAIMSGREEN750', ts: new Date(now).toISOString() }])).toEqual([]);
  expect(familyPlan([...familyLedger(), { event: 'publish', class: 'pr', job: 'RQ-PHX-FLEETCLAIMSGREEN750', ts: new Date(now).toISOString() }])).toEqual([]);
  expect(familyPlan(familyLedger().map(r => ({ ...r, ts: new Date(now - 3 * HOUR * 1000).toISOString() })))).toEqual([]);
  for (const prefix of ['FIXUP-work-', 'guardian-work-', 'RQ-WORKQ8-']) expect(familyPlan(familyLedger(prefix).map(r => ({ ...r, src: 'leader' })))).toEqual([]);
  expect(familyPlan(familyLedger().map(r => ({ ...r, src: 'main-guardian' })))).toEqual([]);
});
it('tick previews then appends one row, preserves existing rows, and does not renew an active stop', async () => {
  await mkdir(join(dir, 'metrics'));
  await writeFile(join(dir, 'metrics/jobs.jsonl'), familyLedger().map(r => JSON.stringify(r)).join('\n'));
  const text = `^other$\t${now / 1000 + HOUR}\tmanual\n`;
  await put('family-stop.tsv', text);
  const base = { runsDir: dir, now, readOff: async () => false, readReport: async () => summarizeEmptyFamilies([], 24) };
  expect((await runEmptyApplyTick({ ...base, apply: false })).familyStops).toHaveLength(1);
  expect(await get('family-stop.tsv')).toBe(text);
  expect((await runEmptyApplyTick({ ...base, apply: true })).familyStops).toHaveLength(1);
  const written = await get('family-stop.tsv');
  expect(written?.split('\n').filter(Boolean)).toHaveLength(2);
  expect(written).toContain('\tauto_0of12_merged_12_empty_');
  expect(new RegExp(written!.split('\n')[1]!.split('\t')[0]!).test('RQ-PHX-FLEETCLAIMSGREEN752')).toBe(true);
  expect(new RegExp(written!.split('\n')[1]!.split('\t')[0]!).test('RQ-PHX-INGESTCONTRACTFINISH754S')).toBe(false);
  expect((await runEmptyApplyTick({ ...base, now: now + HOUR * 1000, apply: true })).familyStops).toEqual([]);
  expect(await get('family-stop.tsv')).toBe(written);
});
it('tick leaves missing ledger evidence unknown and never writes a stop', async () => {
  const result = await runEmptyApplyTick({ runsDir: dir, apply: true, now, readOff: async () => false, readReport: async () => summarizeEmptyFamilies([], 24) });
  expect(result.familyStops).toBeNull(); expect(await get('family-stop.tsv')).toBeNull();
});

it('stop: writes the exact READY ids with an expiry; other lanes, claimed and guarded jobs are left alone', async () => {
  await put('router-queue.md', queue);
  await put('RETIRED', 'RQ-OLD1\n');
  const result = await applyEmptyFamilies({ runsDir: dir, apply: true, now, readReport });
  expect(result.schema).toBe(EMPTY_APPLY_SCHEMA);
  const stop = result.rows.find(r => r.action === 'stop')!;
  expect(stop).toMatchObject({ family: 'RQ-MD*', lane: 'devin-flash', ids: ['RQ-MD6A111806Q8', 'RQ-MD7A111807Q8'], until: now / 1000 + 48 * HOUR });
  expect(stop.reason).toContain('5of5-empty');
  expect(await get('RETIRED')).toBe('RQ-OLD1\nRQ-MD6A111806Q8\nRQ-MD7A111807Q8\n');
});

it('readyJobs resolves the market lane hint: preferred_lane, else lane, else pool; any and no envelope are open', () => {
  expect(readyJobs([
    '- READY RQ-A (P1, pool=any, tier=work, repo=phantom, preferred_lane=claude): x',
    '- READY RQ-B (P1, lane=codex-personal, pool=devin): x',
    '- READY RQ-C (P1, pool=codex-personal): x',
    '- READY RQ-D (P1): x',
    '- READY RQ-E pool=claude: prose outside the envelope names no lane',
  ].join('\n'))).toEqual([
    { id: 'RQ-A', pool: 'claude' },
    { id: 'RQ-B', pool: 'codex-personal' },
    { id: 'RQ-C', pool: 'codex-personal' },
    { id: 'RQ-D', pool: null },
    { id: 'RQ-E', pool: null },
  ]);
});

it('stop: lane hints resolve like the market — preferred_lane beats pool, lane beats pool, any stays open', async () => {
  await put('router-queue.md', [
    '- READY RQ-MD6A111806Q8 (P2, pool=devin-flash, preferred_lane=claude, tier=fast, repo=ashlr-md)',
    '- READY RQ-MD7A111807Q8 (P2, lane=claude, pool=codex-cmp, tier=fast, repo=ashlr-md)',
    '- READY RQ-MD8A111808Q8 (P2, pool=any, tier=fast, repo=ashlr-md)',
  ].join('\n') + '\n');
  const result = await applyEmptyFamilies({ runsDir: dir, apply: true, now, readReport });
  const stop = result.rows.find(r => r.action === 'stop')!;
  expect(stop).toMatchObject({ family: 'RQ-MD*', lane: 'devin-flash', ids: ['RQ-MD8A111808Q8'] });
  expect(await get('RETIRED')).toBe('RQ-MD8A111808Q8\n');
});

it('sign-in empties alone write no lane-avoid hint', async () => {
  await put('router-queue.md', queue);
  const result = await applyEmptyFamilies({ runsDir: dir, apply: true, now, ttlHours: 24, readReport });
  expect(await get('lane-avoid.tsv')).toBeNull();
  expect(result.rows.some(r => r.family === 'RQ-LOGIN*')).toBe(false);
  expect(await get('RETIRED')).not.toContain('RQ-LOGIN4');
});

it('never writes a row for the bare family name leader', async () => {
  await put('router-queue.md', '- READY RQ-WORKN21AQ8 (P1, pool=claude)\n');
  const leader = summarizeEmptyFamilies(launches([1, 2, 3, 4, 5].map(n => `RQ-W${n}N21AQ8`), 'claude', 'already-on-master'), 24);
  const result = await applyEmptyFamilies({ runsDir: dir, apply: true, now, readReport: async () => leader });
  expect(result.rows).toMatchObject([{ family: 'leader', action: 'skip', ids: [] }]);
  expect(await get('RETIRED')).toBeNull();
  expect(await get('lane-avoid.tsv')).toBeNull();
});

it('guarded: FIXUP- and RELEASE families are never stopped', async () => {
  await put('router-queue.md', queue);
  const result = await applyEmptyFamilies({ runsDir: dir, apply: true, now, readReport });
  const guarded = result.rows.filter(r => r.family.startsWith('FIXUP-') || r.family.includes('RELEASE'));
  expect(guarded.length).toBe(2);
  expect(guarded.every(r => r.action === 'skip' && r.ids.length === 0)).toBe(true);
  const retired = await get('RETIRED') ?? '';
  expect(retired).not.toContain('FIXUP-');
  expect(retired).not.toContain('RELEASE');
});

it('dry run writes nothing', async () => {
  await put('router-queue.md', queue);
  const result = await applyEmptyFamilies({ runsDir: dir, apply: false, now, readReport });
  expect(result).toMatchObject({ dry_run: true, written: false, known: true });
  expect(result.rows.some(r => r.action === 'stop')).toBe(true);
  for (const name of ['RETIRED', 'lane-avoid.tsv', 'empty-family-actions.json']) expect(await get(name)).toBeNull();
});

it('undo removes what was written and keeps hand-listed ids', async () => {
  await put('router-queue.md', queue);
  await put('RETIRED', 'RQ-MD7A111807Q8\nRQ-OLD1\n');
  await seedHint(now / 1000 + 48 * HOUR);
  await applyEmptyFamilies({ runsDir: dir, apply: true, now, readReport });
  expect(await get('RETIRED')).toBe('RQ-MD7A111807Q8\nRQ-OLD1\nRQ-MD6A111806Q8\n');
  const undone = await undoEmptyFamily(dir, 'RQ-MD*');
  expect(undone).toMatchObject({ known: true, removed_ids: ['RQ-MD6A111806Q8'], removed_hints: 0 });
  expect(await get('RETIRED')).toBe('RQ-MD7A111807Q8\nRQ-OLD1\n');
  const login = await undoEmptyFamily(dir, 'RQ-LOGIN*');
  expect(login.removed_hints).toBe(1);
  expect(await get('lane-avoid.tsv')).toBe('');
});

it('expired entries are removed on the next apply', async () => {
  await put('router-queue.md', queue);
  await seedHint(now / 1000 + 48 * HOUR);
  await applyEmptyFamilies({ runsDir: dir, apply: true, now, readReport });
  const later = await applyEmptyFamilies({ runsDir: dir, apply: true, now: now + 49 * HOUR * 1000, readReport: async () => summarizeEmptyFamilies([], 24) });
  expect(later.expired_removed).toBe(2);
  expect(await get('RETIRED')).toBe('');
  expect(await get('lane-avoid.tsv')).toBe('');
});

it('shows unknown as unknown: an unreadable report changes nothing', async () => {
  await put('router-queue.md', queue);
  const result = await applyEmptyFamilies({ runsDir: dir, apply: true, now, readReport: async () => null });
  expect(result).toMatchObject({ known: false, written: false });
  expect(await get('RETIRED')).toBeNull();
});

it('tick: skips when the kill switch is on or unknown, and runs at most once an hour', async () => {
  await put('router-queue.md', queue);
  const base = { runsDir: dir, apply: true, readReport };
  expect((await runEmptyApplyTick({ ...base, now, readOff: async () => true })).reason).toBe('empty_stop off');
  expect((await runEmptyApplyTick({ ...base, now, readOff: async () => null })).ran).toBe(false);
  expect(await get('RETIRED')).toBeNull();
  const first = await runEmptyApplyTick({ ...base, now, readOff: async () => false });
  expect(first.ran).toBe(true);
  expect((await runEmptyApplyTick({ ...base, now: now + 30 * 60_000, readOff: async () => false })).reason).toBe('ran within the last hour');
  expect((await runEmptyApplyTick({ ...base, now: now + 61 * 60_000, readOff: async () => false })).ran).toBe(true);
});

it('cli: --apply is a dry run with --dry-run, --json carries the schema id, --undo removes', async () => {
  vi.stubEnv('ASHLR_RUNS_DIR', dir);
  await put('router-queue.md', queue);
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { out.push(line); });
  const read = (async () => null) as never;
  expect(await cmdJobs(['empty', '--by-family', '--apply', '--dry-run', '--json'], read, async () => report)).toBe(0);
  expect(JSON.parse(out.pop()!)).toMatchObject({ schema: EMPTY_APPLY_SCHEMA, dry_run: true, written: false });
  expect(await get('RETIRED')).toBeNull();
  expect(await cmdJobs(['empty', '--by-family', '--apply', '--json'], read, async () => report)).toBe(0);
  expect(JSON.parse(out.pop()!)).toMatchObject({ dry_run: false, written: true });
  expect(await get('RETIRED')).toContain('RQ-MD6A111806Q8');
  expect(await cmdJobs(['empty', '--by-family', '--undo', 'RQ-MD*', '--json'], read, async () => report)).toBe(0);
  expect(JSON.parse(out.pop()!)).toMatchObject({ schema: 'jobs.empty.undo.v1', removed_ids: ['RQ-MD6A111806Q8', 'RQ-MD7A111807Q8'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdJobs(['empty', '--apply'], read, async () => report)).toBe(2);
});

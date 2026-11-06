import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPlannerHealth,
  selectPlannerRunner,
  type PlannerHealth,
} from '../src/core/fleet/planner-failover.js';

// Fixed local-time clock: Oct 31 18:00. All fixture rows sit before it.
const now = new Date(2026, 9, 31, 18, 0, 0).getTime();
const ms = (h: number, min: number, s = 0): number => new Date(2026, 9, 31, h, min, s).getTime();
const row = (clock: string, text: string): string => `2026-10-31 ${clock} ${text}`;
const GOOD = (clock: string) => row(clock, 'LEADER fixups=2 bets=3 reaps=0 ignored=0 free_gb=137');
const FAIL = (clock: string, executor = 'codex') => row(clock, `LEADER ${executor} rc=0`);
const USAGE_LIMIT_LOG = [
  'planner pass starting',
  'ERROR: You have hit your usage limit. Upgrade to Pro (https://example.invalid/pro) or try again at Nov 4th, 2026 1:41 AM.',
].join('\n');

async function runsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'planner-failover-'));
  await mkdir(join(dir, 'queue'), { recursive: true });
  await mkdir(join(dir, 'supervisor'));
  return dir;
}

describe('readPlannerHealth', () => {
  it('flags a usage-limit death behind rc=0 rows and parses the advertised reset', async () => {
    const dir = await runsDir();
    try {
      await writeFile(join(dir, 'queue/dispatch-events.log'), [
        row('00:47:39', 'INBOX new entry from test'),
        GOOD('13:00:00'), FAIL('14:14:03'), row('14:20:00', 'LAUNCH RQ-FAKE-1'), FAIL('14:29:03'), FAIL('14:44:03'),
      ].join('\n'));
      await writeFile(join(dir, 'supervisor/run.20261031-1414.log'), USAGE_LIMIT_LOG);
      const health = await readPlannerHealth(dir, now);
      expect(health.status).toBe('failing');
      expect(health.reason).toBe('usage-limit');
      expect(Date.parse(health.failingSince!)).toBe(ms(14, 14, 3));
      expect(Date.parse(health.lastGoodPassAt!)).toBe(ms(13, 0, 0));
      expect(Date.parse(health.resetAt!)).toBe(new Date(2026, 10, 4, 1, 41).getTime());
      expect(health.resetAt).toMatch(/^2026-11-04T01:41:00[+-]\d\d:\d\d$/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reports ok when a later LEADER fixups= row is the newest pass', async () => {
    const dir = await runsDir();
    try {
      await writeFile(join(dir, 'queue/dispatch-events.log'), [FAIL('14:14:03'), GOOD('15:00:00')].join('\n'));
      await writeFile(join(dir, 'supervisor/run.20261031-1414.log'), USAGE_LIMIT_LOG);
      const health = await readPlannerHealth(dir, now);
      expect(health).toMatchObject({ status: 'ok', failingSince: null, reason: null });
      expect(Date.parse(health.lastGoodPassAt!)).toBe(ms(15, 0, 0));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reports unknown for missing files and for an events tail with no LEADER rows', async () => {
    const dir = await runsDir();
    try {
      expect((await readPlannerHealth(dir, now))).toMatchObject({
        status: 'unknown', reason: 'missing-events-log', failingSince: null, lastGoodPassAt: null, resetAt: null });
      await writeFile(join(dir, 'queue/dispatch-events.log'), [row('14:00:00', 'LAUNCH RQ-FAKE-1'), row('14:05:00', 'INBOX ping')].join('\n'));
      expect((await readPlannerHealth(dir, now)).reason).toBe('no-leader-rows');
      await rm(join(dir, 'queue/dispatch-events.log'));
      await mkdir(join(dir, 'queue/dispatch-events.log'));
      expect((await readPlannerHealth(dir, now)).reason).toBe('unreadable-events-log');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('keeps resetAt null when the advertised time does not parse', async () => {
    const dir = await runsDir();
    try {
      await writeFile(join(dir, 'queue/dispatch-events.log'), FAIL('14:14:03'));
      await writeFile(join(dir, 'supervisor/run.20261031-1414.log'),
        'ERROR: usage limit reached; try again at tea time\nERROR: try again at Nov 4th, 2026 1:41\n');
      const health = await readPlannerHealth(dir, now);
      // "tea time" never parses; "Nov 4th, 2026 1:41" has no AM/PM — no guessing.
      expect(health).toMatchObject({ status: 'failing', reason: 'usage-limit', resetAt: null });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reads an rc= row without exhaustion evidence as executor-fail', async () => {
    const dir = await runsDir();
    try {
      await writeFile(join(dir, 'queue/dispatch-events.log'), [GOOD('13:00:00'), FAIL('14:14:03')].join('\n'));
      await writeFile(join(dir, 'supervisor/run.20261031-1414.log'), 'planner died: synthetic render fault\n');
      expect(await readPlannerHealth(dir, now)).toMatchObject({ status: 'failing', reason: 'executor-fail', resetAt: null });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reads the events log at the runs-root fallback and only the newest run log', async () => {
    const dir = await runsDir();
    try {
      await writeFile(join(dir, 'dispatch-events.log'), FAIL('14:14:03'));
      await writeFile(join(dir, 'supervisor/run.20261030-0900.log'), USAGE_LIMIT_LOG);
      await writeFile(join(dir, 'supervisor/run.20261031-1414.log'), 'planner died: synthetic render fault\n');
      const old = new Date(2026, 9, 30, 9), newer = new Date(2026, 9, 31, 14, 14);
      await utimes(join(dir, 'supervisor/run.20261030-0900.log'), old, old);
      await utimes(join(dir, 'supervisor/run.20261031-1414.log'), newer, newer);
      // The usage-limit text sits in the OLDER run log; the newest wins the reason.
      expect(await readPlannerHealth(dir, now)).toMatchObject({ status: 'failing', reason: 'executor-fail', resetAt: null });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('ignores LEADER rows dated after now', async () => {
    const dir = await runsDir();
    try {
      await writeFile(join(dir, 'queue/dispatch-events.log'), [FAIL('14:14:03'), GOOD('23:59:59')].join('\n'));
      expect((await readPlannerHealth(dir, now)).status).toBe('failing');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

const limited = (resetAt: string | null): PlannerHealth =>
  ({ status: 'failing', failingSince: 'x', lastGoodPassAt: null, resetAt, reason: 'usage-limit' });
const CANDIDATES = [
  { provider: 'codex', argv: ['codex', 'exec'] },
  { provider: 'claude', argv: ['claude', '-p'] },
] as const;

describe('selectPlannerRunner', () => {
  const reset = new Date(2026, 10, 1, 9).toISOString();
  const beforeReset = new Date(2026, 10, 1, 8).getTime();
  const afterReset = new Date(2026, 10, 1, 10).getTime();

  it('skips a limited provider and takes the next candidate', () => {
    const choice = selectPlannerRunner(CANDIDATES, { codex: limited(reset) }, beforeReset);
    expect(choice).toEqual({ ok: true, provider: 'claude', argv: ['claude', '-p'] });
  });

  it('returns the provider again once its resetAt has passed', () => {
    expect(selectPlannerRunner(CANDIDATES, { codex: limited(reset) }, afterReset))
      .toMatchObject({ ok: true, provider: 'codex' });
    expect(selectPlannerRunner(CANDIDATES, { codex: limited(reset) }, Date.parse(reset)))
      .toMatchObject({ ok: true, provider: 'codex' });
  });

  it('returns ok:false with a reason when every provider is limited', () => {
    const later = new Date(2026, 10, 2, 9).toISOString();
    const choice = selectPlannerRunner(CANDIDATES, { codex: limited(reset), claude: limited(later) }, beforeReset);
    expect(choice).toEqual({ ok: false, reason: 'all candidates are usage-limited', nextResetAt: reset });
    expect(selectPlannerRunner(CANDIDATES, { codex: limited(null), claude: limited(null) }, beforeReset))
      .toEqual({ ok: false, reason: 'all candidates are usage-limited', nextResetAt: null });
    expect(selectPlannerRunner([], {}, beforeReset)).toEqual({ ok: false, reason: 'no candidates', nextResetAt: null });
  });

  it('does not skip providers failing for other reasons or never read', () => {
    const executorFail: PlannerHealth = { status: 'failing', failingSince: 'x', lastGoodPassAt: null, resetAt: null, reason: 'executor-fail' };
    expect(selectPlannerRunner(CANDIDATES, { codex: executorFail }, beforeReset)).toMatchObject({ ok: true, provider: 'codex' });
    expect(selectPlannerRunner(CANDIDATES, { codex: limited(reset), claude: { ...executorFail, status: 'unknown' } }, beforeReset))
      .toMatchObject({ ok: true, provider: 'claude' });
  });
});

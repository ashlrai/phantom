import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readUsagePace } from '../src/core/usage/pace.js';
import { readUsageSpend } from '../src/core/usage/spend.js';

/**
 * `readUsageSpend`/`readUsagePace` default to the dispatcher's status.json.
 * Every sibling fleet reader resolves ASHLR_RUNS_DIR ?? ~/.ashlr-runs; these
 * two skipped the override, so `phm spend`, `phm fleet spend`, `phm usage`,
 * `phm usage pace` and the usage APIs read the wrong fleet root whenever the
 * override points the fleet elsewhere. Each test seeds the override root and
 * a decoy under a relocated HOME, then proves the override root wins.
 */

const dirs: string[] = [];
let savedEnv: string | undefined;
let savedHome: string | undefined;

function statusJson(usedPct: number, projectedPct: number): string {
  const now = Date.now();
  return JSON.stringify({
    schema: 'dispatchd.status.v1',
    last_tick: new Date(now).toISOString(),
    budget: {
      'codex-personal': {
        use_it_all: {
          known: true, stale: false, used_pct: usedPct, burn_pct_per_hour: 5,
          reset_at: new Date(now + 10 * 3_600_000).toISOString(),
          projected_used_pct: projectedPct, hours_to_reset: 10,
        },
      },
    },
  });
}

/** Seed `<root>/queue/status.json`; returns nothing. */
async function seed(root: string, usedPct: number, projectedPct: number): Promise<void> {
  await mkdir(join(root, 'queue'), { recursive: true });
  await writeFile(join(root, 'queue', 'status.json'), statusJson(usedPct, projectedPct));
}

/**
 * Point ASHLR_RUNS_DIR at `envDir` (used_pct 25) and HOME at `homeDir`
 * (decoy used_pct 90). The readers must answer from the override root.
 */
async function pointAt(envPct: number, homePct: number): Promise<{ envDir: string; homeDir: string }> {
  savedEnv = process.env.ASHLR_RUNS_DIR;
  savedHome = process.env.HOME;
  const envDir = await mkdtemp(join(tmpdir(), 'usage-runs-env-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'usage-runs-home-'));
  dirs.push(envDir, homeDir);
  await seed(envDir, envPct, envPct + 35);
  await seed(join(homeDir, '.ashlr-runs'), homePct, homePct + 5);
  process.env.ASHLR_RUNS_DIR = envDir;
  process.env.HOME = homeDir;
  return { envDir, homeDir };
}

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = savedEnv;
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  savedEnv = undefined;
  savedHome = undefined;
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('usage spend and pace reads honor ASHLR_RUNS_DIR', () => {
  it('readUsageSpend defaults to the override root, not ~/.ashlr-runs', async () => {
    await pointAt(25, 90);
    const spend = await readUsageSpend();
    const row = spend.pools.find(pool => pool.pool === 'codex-personal');
    expect(row?.usedPercent).toBe(25);
    expect(row?.usedPercent).not.toBe(90);
  });

  it('readUsagePace defaults to the override root, not ~/.ashlr-runs', async () => {
    await pointAt(25, 90);
    const pace = await readUsagePace();
    const row = pace.pools.find(pool => pool.pool === 'codex-personal');
    // env projected_used_pct = 25 + 35 = 60; the decoy's would be 95.
    expect(row?.projectedPercent).toBe(60);
    expect(row?.projectedPercent).not.toBe(95);
  });

  it('an explicit status path still wins over the override', async () => {
    await pointAt(25, 90);
    const otherDir = await mkdtemp(join(tmpdir(), 'usage-runs-other-'));
    dirs.push(otherDir);
    await seed(otherDir, 40, 75);
    const spend = await readUsageSpend(join(otherDir, 'queue', 'status.json'));
    expect(spend.pools.find(pool => pool.pool === 'codex-personal')?.usedPercent).toBe(40);
  });
});

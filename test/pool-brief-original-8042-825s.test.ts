import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readCompactBrief } from '../src/core/fleet/leader-compact-brief.js';
import { groupHostFamilies } from '../src/core/fleet/host-families.js';

const now = Date.parse('2026-11-21T12:00:00Z');
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it('projects local pool evidence into the compact brief without a reserve or billing inference', async () => {
  root = await mkdtemp(join(tmpdir(), 'pool-brief-8042-'));
  await mkdir(join(root, 'queue'));
  await mkdir(join(root, 'metrics'));
  await writeFile(join(root, 'queue/status.json'), JSON.stringify({ last_tick: at(0),
    lanes: { 'devin-flash': { running: 1, target: 3 } },
    budget: {
      claude: { used_pct: 99, reset_at: at(10), burn_pct_per_hour: 1 },
      'codex-cmp': { used_pct: 100, reset_at: at(12) },
    },
  }));
  await writeFile(join(root, 'queue/grok-reading.json'), JSON.stringify({ pct: 30, ts: now / 1000 - 72 * 3600, reset_at: at(10) }));
  await writeFile(join(root, 'metrics/usage-history.json'), JSON.stringify({ schema: 'fleet.usage-history.v1', v: 1,
    rows: [-1, 0].map(h => ({ pool: 'cursor', used_pct: 20 + h, observed_at: at(h), reset_at: at(10), source: 'synthetic' })) }));

  const brief = await readCompactBrief(root, now, async () => groupHostFamilies(null));
  const pool = (name: string) => brief.pools.find(p => p.pool === name);
  expect(brief.sources.pace.state).toBe('healthy');
  expect(pool('cursor')).toMatchObject({ usedPct: 20, source: 'metrics/usage-history.json', ageHours: 0, burnPerHour: 1 });
  expect(pool('grok')).toMatchObject({ usedPct: null, source: 'queue/grok-reading.json', ageHours: 72,
    verdict: 'grok: stale (72h); refresh the provider reading' });
  expect(pool('codex-cmp')).toMatchObject({ usedPct: 100, source: 'queue/status.json', safeBurn: 0,
    verdict: `codex-cmp: spent until ${at(12)}` });
  expect(pool('claude')).toMatchObject({ usedPct: 99, source: 'queue/status.json', safeBurn: 0.1, verdict: 'over' });
  expect(pool('devin-flash')).toMatchObject({ usedPct: null, source: 'queue/status.json lane slots', headroom: { slots: 2 },
    verdict: expect.stringContaining('slot headroom is not billing eligibility') });
});

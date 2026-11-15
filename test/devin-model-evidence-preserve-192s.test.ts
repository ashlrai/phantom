/**
 * devin-model-evidence-preserve-192s.test.ts — RQ-PHX-DEVINMODELEVIDENCEPORT192S.
 *
 * Preservation port of the regression coverage PR #4786 (source head
 * 46f19a08d576f42bad523656755a7f7e88fcbab1, underlying #4768) added as
 * test/devin-fleet-model-preservation-10ssf3.test.ts and
 * test/devin-overview-fleet-model.test.ts (plus the DevinResource fleetmodel
 * UI narrowing). That PR's `fleetModel` evidence surface —
 * devinOverview().fleetModel {configured, source, promo, laneModels} and the
 * devinFleetModelEvidence helper — is NOT on master b3a171f4e7: the contract
 * moved to the native-evidence guard (cli-admission / nativeFreeModelVerified)
 * and the CLI model-catalog summary. Every original scenario is kept below
 * against the current equivalent APIs. The test asserts observed eligibility
 * only; it never claims any model is currently free.
 *
 * Scenario → current-API mapping:
 *  - overview.fleetModel.promo 'free' | 'not-free' | 'unknown'
 *      → isDevinCliFreeModel(model, nowMs): true | false | false. The promo
 *        tri-state collapsed to a boolean — 'unknown' and 'not-free' are both
 *        "not observed free", and neither is ever a free claim.
 *  - overview.fleetModel.configured / .source
 *      → resolveDevinCliFleetModel(section, override): config value, else the
 *        compiled default; a paid -lightning id resolves to swe-2-flash-max.
 *  - overview.fleetModel.laneModels [{key, model, paid}]
 *      → getLaneModelSnapshot({runsDir}).lanes[].tiers[] attribution over a
 *        synthetic models.json; `paid` → isDevinCliFreeModel(model, clock)
 *        is false (paid ids are simply never on the free list).
 *  - DevinServiceDeps.laneModels injection → removed; the lane read is the
 *        real getLaneModelSnapshot over a temp runs dir.
 *  - devinCliFleetModelPromo(model, Date) → isDevinCliFreeModel(model, ms).
 *  - devinFleetModelEvidence(raw) → devinModelsLines(models): the UI's
 *        current model-evidence narrowing in the same devin-model.ts module
 *        (absent/malformed → null, never a guessed claim).
 *  - devinOverview().fleetModel → removed. devinOverview still runs for real
 *        and must not fabricate model evidence: `models` appears only when
 *        the CLI probe observed a catalog.
 *
 * Hermetic: temp runs dir only; cliProbe/modelCatalog are injected; no Devin
 * API call, no network. HOME is isolated by test/setup/home.ts.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEVIN_CLI_PROMOTION_EVIDENCE_BOUNDARY,
  devinCliLaneVerdict,
  isDevinCliFreeModel,
  resolveDevinCliFleetModel,
} from '../src/core/devin/cli-engine.js';
import { fallbackDevinModelCatalog } from '../src/core/devin/models.js';
import { devinOverview, type DevinServiceDeps } from '../src/core/devin/service.js';
import { getLaneModelSnapshot } from '../src/core/fleet/lane-models.js';
import { devinModelsLines } from '../src/web-ui/routes/verse/devin/devin-model.js';
import type { AshlrConfig } from '../src/core/types.js';

const BEFORE = new Date(DEVIN_CLI_PROMOTION_EVIDENCE_BOUNDARY - 60_000);
const AFTER = new Date(DEVIN_CLI_PROMOTION_EVIDENCE_BOUNDARY + 60_000);
const BEFORE_MS = BEFORE.getTime();
const AFTER_MS = AFTER.getTime();

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'devin-model-evidence-192s-')); });
afterEach(async () => rm(dir, { recursive: true, force: true }));

function deps(fleetModel: string | undefined, now: Date, extra: Partial<DevinServiceDeps> = {}): DevinServiceDeps {
  const devin: AshlrConfig['devin'] = { enabled: true, fleet: true, ...(fleetModel ? { fleetModel } : {}) };
  return {
    config: () => devin,
    cliProbe: async () => ({ state: 'missing' }),
    now: () => now,
    ...extra,
  };
}

describe('#4786 fleet-model evidence preservation (ported to current APIs)', () => {
  it('paid -lightning stays refused on both sides of the boundary; models.json attribution is observed, never a free claim', async () => {
    await writeFile(join(dir, 'models.json'), JSON.stringify({ devin: 'swe-2-high', 'devin.fast': 'swe-2-max-lightning' }));
    for (const now of [BEFORE, AFTER]) {
      // Paid lightning selection resolves to the paid fallback — never a free id.
      expect(resolveDevinCliFleetModel({ fleetModel: 'swe-2-max-lightning' })).toBe('swe-2-flash-max');
      for (const paid of ['swe-2-max-lightning', 'swe-2-flash-max']) {
        expect(isDevinCliFreeModel(paid, now.getTime())).toBe(false);
      }
      // The real overview runs at the fixed clock and fabricates no model evidence.
      const overview = await devinOverview(deps('swe-2-max-lightning', now));
      expect(overview.generatedAt).toBe(now.toISOString());
      expect(overview).not.toHaveProperty('fleetModel');
      expect(overview.models).toBeUndefined(); // probe missing → no catalog claim
      // Lane attribution from the synthetic models.json (the old laneModels field).
      const snap = await getLaneModelSnapshot({ runsDir: dir, now: () => now });
      const lane = snap.lanes.find((l) => l.lane === 'devin');
      expect(lane).toBeDefined();
      const row = (tier: string) => lane!.tiers.find((r) => r.tier === tier)!;
      expect(row('fast')).toMatchObject({ model: 'swe-2-max-lightning', via: 'devin.fast' });
      for (const tier of ['frontier', 'work', 'mid', 'low']) {
        expect(row(tier)).toMatchObject({ model: 'swe-2-high', via: 'devin' });
      }
      // `paid` on the old row → the id is simply never observed free.
      expect(isDevinCliFreeModel(row('fast').model!, now.getTime())).toBe(false);
      expect(isDevinCliFreeModel(row('work').model!, BEFORE_MS)).toBe(true); // listed id, before boundary only
      expect(isDevinCliFreeModel(row('work').model!, AFTER_MS)).toBe(false);
    }
  });

  it('a listed id is observed-eligible only before the boundary; unlisted ids and a NaN clock are never free', async () => {
    // promo 'free' → true; 'not-free' → false; 'unknown' → false (never a claim).
    expect(isDevinCliFreeModel('swe-2-high', BEFORE_MS)).toBe(true);
    expect(isDevinCliFreeModel('swe-2-medium', BEFORE_MS)).toBe(true);
    expect(isDevinCliFreeModel('swe-2-high', AFTER_MS)).toBe(false);
    for (const unlisted of ['swe-2-custom', 'swe-1-7-lightning', 'claude-opus-5-5-high']) {
      expect(isDevinCliFreeModel(unlisted, BEFORE_MS)).toBe(false);
      expect(isDevinCliFreeModel(unlisted, AFTER_MS)).toBe(false);
    }
    expect(isDevinCliFreeModel('swe-2-high', Number.NaN)).toBe(false); // NaN clock → unknown → not free
    // Missing evidence never becomes free: an unlisted configured id still
    // shows no model claim, and the lane verdict holds without native proof.
    const unlisted = await devinOverview(deps('swe-2-custom', BEFORE));
    expect(unlisted).not.toHaveProperty('fleetModel');
    expect(unlisted.models).toBeUndefined();
    const held = devinCliLaneVerdict({
      section: { enabled: true, fleet: true },
      grant: { ok: true, reason: 'granted' },
      budgetAllowsDevin: true,
      budgetMode: 'balanced',
      probe: { state: 'ready', reason: null },
      model: 'swe-2-high',
      // nativeFreeModelVerified absent → unknown, never a free fallback.
    });
    expect(held.ok).toBe(false);
    expect(held.reason).toMatch(/unconfirmed/);
  });

  it('configured, default and per-run model resolution; paid lightning never falls through to a configured free id', () => {
    // configured / default / override — the old fleetModel.configured + source.
    expect(resolveDevinCliFleetModel(undefined)).toBe('swe-2-high');
    expect(resolveDevinCliFleetModel({ fleetModel: 'swe-2-max' })).toBe('swe-2-max');
    expect(resolveDevinCliFleetModel({ fleetModel: 'swe-2-max' }, 'swe-2-medium')).toBe('swe-2-medium');
    expect(resolveDevinCliFleetModel({ fleetModel: 'swe-2-max-lightning' })).toBe('swe-2-flash-max');
    expect(resolveDevinCliFleetModel({ fleetModel: 'swe-2-flash' }, 'swe-2-high-lightning')).toBe('swe-2-flash-max');
  });

  it('attributes every models.json lane key and degrades missing or malformed evidence without error', async () => {
    await writeFile(join(dir, 'models.json'), JSON.stringify({
      devin: 'swe-2-high', 'devin.fast': 'swe-2-max-lightning', 'devin-flash': 'swe-2-medium',
      claude: 'claude-opus-4-8', 'codex.frontier': 'gpt-5.4-codex',
    }));
    const snap = await getLaneModelSnapshot({ runsDir: dir, now: () => AFTER });
    expect(snap.sources.models).toMatchObject({ state: 'healthy', file: 'models.json', entries: 5 });
    const tier = (laneId: string, t: string) => snap.lanes.find((l) => l.lane === laneId)!.tiers.find((r) => r.tier === t)!;
    expect(tier('devin', 'fast')).toMatchObject({ model: 'swe-2-max-lightning', via: 'devin.fast' });
    expect(tier('devin', 'work')).toMatchObject({ model: 'swe-2-high', via: 'devin' });
    expect(tier('devin-flash', 'mid')).toMatchObject({ model: 'swe-2-medium', via: 'devin-flash' });
    expect(tier('claude', 'frontier')).toMatchObject({ model: 'claude-opus-4-8', via: 'claude' });
    expect(tier('codex', 'frontier')).toMatchObject({ model: 'gpt-5.4-codex', via: 'codex.frontier' });
    expect(tier('codex', 'work').model).toBeNull();

    // Missing models.json → 'missing' + no lanes; malformed → 'degraded'; never an exception.
    const empty = await getLaneModelSnapshot({ runsDir: join(dir, 'absent'), now: () => AFTER });
    expect(empty.sources.models.state).toBe('missing');
    expect(empty.lanes).toEqual([]);
    await writeFile(join(dir, 'models.json'), '{ broken');
    const degraded = await getLaneModelSnapshot({ runsDir: dir, now: () => AFTER });
    expect(degraded.sources.models.state).toBe('degraded');
    expect(degraded.lanes).toEqual([]);
    await writeFile(join(dir, 'models.json'), '[]');
    expect((await getLaneModelSnapshot({ runsDir: dir, now: () => AFTER })).sources.models.state).toBe('degraded');
  });

  it('the overview displays only observed catalog evidence; absent or malformed UI evidence narrows to null', async () => {
    // Real overview with an injected catalog: `models` appears only because the
    // probe observed the CLI — never from config or models.json alone.
    const observed = await devinOverview({
      config: () => ({ enabled: true }),
      cliProbe: async () => ({ state: 'ready', cliPath: null }),
      modelCatalog: async () => fallbackDevinModelCatalog(),
      now: () => AFTER,
    });
    expect(observed.models).toMatchObject({ source: 'fallback', defaultModel: { id: 'swe-2-high', free: true } });
    expect(devinModelsLines(observed.models)).toMatchObject({
      catalog: 'Models: SWE-2 (free)',
      defaultLine: 'Default: SWE-2 High (Free)',
      stale: true,
    });

    // Absent or malformed evidence → null (the old devinFleetModelEvidence contract).
    for (const bad of [
      undefined, null, {},
      { freeFamilies: 'SWE-2', paidFamilyCount: 0, defaultModel: { label: 'x' } },
      { freeFamilies: [], paidFamilyCount: 1.5, defaultModel: { label: 'x' } },
      { freeFamilies: [], paidFamilyCount: 0, defaultModel: { id: 'x' } },
    ]) {
      expect(devinModelsLines(bad)).toBeNull();
    }
    // A paid default never reads as free.
    const paid = devinModelsLines({
      source: 'cli', fetchedAt: null, freeFamilies: [], paidFamilyCount: 2,
      defaultModel: { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5', free: false, price: '$4 in · $20 out per 1M' },
    });
    expect(paid?.defaultLine).toBe('Default: Claude Opus 5.5 ($4 in · $20 out per 1M)');
    expect(paid?.catalog).toBe('Models: 2 paid families');
  });
});

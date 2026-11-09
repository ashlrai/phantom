/**
 * Lane sizing for small-Mac oMLX nodes (RQ-OMLX-DISTILL-1): RAM-aware model
 * pick, service-tier caps and swap backoff — all deterministic over recorded
 * evidence, and the checked-in benchmark file pinned identical to the catalog
 * the planner runs on.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OMLX_MODEL_CANDIDATES, OMLX_MODEL_CATALOG, evidenceTiers, isLocalModelCap,
  parseOmlxModelCatalog, planOmlxLocalLanes, qualityScore,
  type OmlxLaneConfig,
} from '../src/core/local-runtime/omlx/models.js';

const GiB = 1024 ** 3;
const head = (freePercent: number, swapGb = 0, pressureLevel: 1 | 2 | 4 = 1) => ({ freePercent, swapGb, pressureLevel });
const open = (over: Partial<OmlxLaneConfig> = {}): OmlxLaneConfig => ({ enabled: true, ...over });
const plan = (totalGiB: number, freePercent: number, swapGb = 0, config = open(), pressureLevel: 1 | 2 | 4 = 1) =>
  planOmlxLocalLanes({ totalBytes: totalGiB * GiB, headroom: head(freePercent, swapGb, pressureLevel), config, platform: 'darwin' });

describe('recorded candidate catalog', () => {
  it('benchmarks/omlx-model-candidates.json is byte-identical to the compiled catalog', () => {
    const file = JSON.parse(readFileSync(join(__dirname, '..', 'benchmarks', 'omlx-model-candidates.json'), 'utf8')) as {
      schemaVersion: number; recordedAt: string; candidates: unknown[];
    };
    expect(file.schemaVersion).toBe(1);
    expect(file.recordedAt).toBe(OMLX_MODEL_CATALOG.recordedAt);
    expect(file.candidates).toEqual(OMLX_MODEL_CATALOG.candidates);
  });

  it('validates strictly and rejects malformed or duplicated rows', () => {
    expect(parseOmlxModelCatalog(OMLX_MODEL_CATALOG).candidates).toHaveLength(OMLX_MODEL_CANDIDATES.length);
    expect(() => parseOmlxModelCatalog({ schemaVersion: 1, recordedAt: 'x', candidates: [{ id: 'bad' }] })).toThrow('Invalid oMLX model candidate');
    expect(() => parseOmlxModelCatalog({ schemaVersion: 1, recordedAt: 'x', candidates: [OMLX_MODEL_CANDIDATES[0], OMLX_MODEL_CANDIDATES[0]] })).toThrow('Duplicate');
    expect(() => parseOmlxModelCatalog({ schemaVersion: 2, recordedAt: 'x', candidates: OMLX_MODEL_CANDIDATES })).toThrow('Invalid oMLX model catalog');
  });

  it('carries decision-grade evidence for every candidate', () => {
    for (const c of OMLX_MODEL_CANDIDATES) {
      expect(c.repo).toMatch(/^mlx-community\//);
      expect(c.quantization).toBe('4bit');
      expect(c.servedContext).toBeLessThanOrEqual(c.contextLength);
      expect(c.weightsBytes).toBeGreaterThan(0);
      expect(c.evidence.quality.source).toBeTruthy();
      // Quality evidence exists for every candidate except the plainly-marked gap.
      if (c.id !== 'qwen3-8b-4bit') expect(qualityScore(c)).not.toBeNull();
    }
  });
});

describe('service tiers from recorded evidence', () => {
  it('coder-7b reaches work tier; the 14b and the small pick do not', () => {
    const byId = Object.fromEntries(OMLX_MODEL_CANDIDATES.map(c => [c.id, c]));
    expect(evidenceTiers(byId['qwen2.5-coder-7b-instruct-4bit']!)).toEqual(['work']);
    // Measured 10.6 TG/s on M4 16GB misses the 15 TG/s work floor — evidence, not a guess.
    expect(evidenceTiers(byId['qwen2.5-coder-14b-instruct-4bit']!)).toEqual([]);
    expect(evidenceTiers(byId['qwen3-4b-instruct-2507-4bit']!)).toEqual([]);
    expect(evidenceTiers(byId['deepseek-r1-distill-qwen-7b-4bit']!)).toEqual([]);
    expect(evidenceTiers(byId['qwen3-8b-4bit']!)).toEqual(['work']);
  });
});

describe('RAM-aware lane sizing', () => {
  it('8 GB node picks the 4B instruct at one slot and advertises omlx only', () => {
    const p = plan(8, 60);
    expect(p.model?.id).toBe('qwen3-4b-instruct-2507-4bit');
    expect(p.slots).toBe(1);
    expect(p.caps).toEqual(['omlx']);
    expect(p.suggestedCaps).toBe('omlx');
    expect(p.backoff).toBeNull();
    expect(p.rejected.map(r => r.id)).toContain('qwen2.5-coder-7b-instruct-4bit');
  });

  it('16 GB node picks the measured coder-7b at two slots and advertises omlx,omlx-work', () => {
    const p = plan(16, 55);
    expect(p.model?.id).toBe('qwen2.5-coder-7b-instruct-4bit');
    expect(p.slots).toBe(2);
    expect(p.caps).toEqual(['omlx', 'omlx-work']);
    // The 14B is rejected by the envelope — not by a hard-coded size rule.
    expect(p.rejected.find(r => r.id === 'qwen2.5-coder-14b-instruct-4bit')?.reason).toContain('envelope');
    // The distill fit but lost on evidence.
    expect(p.rejected.map(r => r.id)).not.toContain('deepseek-r1-distill-qwen-7b-4bit');
  });

  it('every emitted cap is a recognized local model cap', () => {
    for (const gib of [8, 16, 24, 36, 64]) {
      const p = plan(gib, 60);
      for (const cap of p.caps) expect(isLocalModelCap(cap)).toBe(true);
    }
  });

  it('larger RAM still prefers the evidence pick over the bigger 14b', () => {
    // The 14B only wins when its decode meets the work floor somewhere it is
    // actually measured to; the recorded 10.6 TG/s never reaches it.
    const p = plan(36, 60);
    expect(p.model?.id).toBe('qwen2.5-coder-7b-instruct-4bit');
  });

  it('slots grow with spare KV room but stay under the configured cap', () => {
    expect(plan(16, 60, 0, open({ maxSlots: 4 })).slots).toBe(4);
    expect(plan(16, 60, 0, open({ maxSlots: 1 })).slots).toBe(1);
  });

  it('a configured model pin is honored when it fits', () => {
    const p = plan(16, 60, 0, open({ model: 'deepseek-r1-distill-qwen-7b-4bit' }));
    expect(p.model?.id).toBe('deepseek-r1-distill-qwen-7b-4bit');
    expect(p.caps).toEqual(['omlx']); // no measured rates, no tier caps
  });

  it('holds the lane when nothing fits the envelope', () => {
    const p = plan(6, 60);
    expect(p.model).toBeNull();
    expect(p.caps).toEqual([]);
    expect(p.backoff).toBe('no-fitting-model');
    expect(p.rejected.length).toBe(OMLX_MODEL_CANDIDATES.length);
  });
});

describe('swap and pressure backoff', () => {
  it('backs off when kernel memory pressure is above normal', () => {
    const p = plan(16, 60, 0, open(), 4);
    expect(p.caps).toEqual([]);
    expect(p.slots).toBe(0);
    expect(p.backoff).toBe('memory-pressure');
    expect(p.backoffReason).toContain('pressure');
  });

  it('backs off on warning-level pressure and on missing telemetry', () => {
    expect(plan(16, 60, 0, open(), 2).backoff).toBe('memory-pressure');
    const p = planOmlxLocalLanes({ totalBytes: 16 * GiB, headroom: null, config: open(), platform: 'darwin' });
    expect(p.backoff).toBe('telemetry-unavailable');
    expect(p.caps).toEqual([]);
  });

  it('stays closed when disabled, unconfigured or off macOS', () => {
    expect(plan(16, 60, 0, { enabled: false }).backoff).toBe('disabled');
    expect(planOmlxLocalLanes({ totalBytes: 16 * GiB, headroom: head(60), config: null, platform: 'darwin' }).backoff).toBe('disabled');
    expect(planOmlxLocalLanes({ totalBytes: 16 * GiB, headroom: head(60), config: open(), platform: 'linux' }).backoff).toBe('unsupported-platform');
    expect(planOmlxLocalLanes({ totalBytes: 16 * GiB, headroom: head(60), config: open(), platform: 'linux' }).caps).toEqual([]);
  });

  it('backoff is decided at probe time: a later pressured node stops advertising', () => {
    const first = plan(16, 60, 0);
    const later = plan(16, 60, 0, open(), 2);
    expect(first.suggestedCaps).toBe('omlx,omlx-work');
    expect(later.suggestedCaps).toBe('');
  });
});

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { armKey, armPrior, loadArmRegistry, parseArmKey, saveArmRegistry, updateArm } from '../src/core/routing/arms.js';

describe('arm registry', () => {
  it('round trips provider, model and effort without collisions', () => {
    for (const [provider, model] of [['codex', 'gpt-6.1-sol'], ['codex', 'gpt-6-astra'], ['codex', 'gpt-6.1-terra'], ['claude', 'opus'], ['grok-cli', 'grok-4.7'], ['devin', 'default'], ['local', 'omlx']]) {
      const arm = { provider: provider!, model: model!, effort: 'high' };
      expect(parseArmKey(armKey(arm))).toEqual(arm);
    }
    expect(parseArmKey('codex:model:high:extra')).toBeNull();
    expect(() => armKey({ provider: 'codex', model: 'bad:model', effort: 'high' })).toThrow();
  });

  it('seeds only meaningful scores and updates both distributions', () => {
    const score = { key: 'codex:sol', engine: 'codex' as const, model: 'sol', score: 0.8, samples: 10 };
    const prior = armPrior(score);
    expect(prior.merge.alpha).toBeCloseTo(9);
    expect(prior.merge.beta).toBeCloseTo(3);
    expect(armPrior({ ...score, samples: 2 }).merge).toEqual({ alpha: 1, beta: 1 });
    const updated = updateArm(updateArm(prior, true, 2), false, 0);
    expect(updated.merge.alpha).toBeCloseTo(10);
    expect(updated.merge.beta).toBeCloseTo(4);
    expect(updated.cost).toEqual({ shape: 3, rate: 3 });
    expect(() => updateArm(prior, true, -1)).toThrow();
  });

  it('persists privately and refuses to overwrite corrupt snapshots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arms-'));
    try {
      const file = join(dir, 'routing', 'arms.json');
      const registry = new Map([['codex:gpt-6.1-sol:high', updateArm(armPrior(), true, 0.5)]]);
      expect(loadArmRegistry(file).size).toBe(0);
      saveArmRegistry(registry, file);
      expect(loadArmRegistry(file)).toEqual(registry);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      writeFileSync(file, '{broken');
      expect(() => saveArmRegistry(registry, file)).toThrow();
      expect(readFileSync(file, 'utf8')).toBe('{broken');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

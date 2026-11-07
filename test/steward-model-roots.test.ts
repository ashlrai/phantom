/**
 * Model weight caches are never disk-maint victims by default
 * (RQ-OMLX-DISTILL-1 acceptance): the steward allowlist must never admit a
 * protected model root, and runSteward must refuse even a crafted root that
 * points inside one.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isProtectedModelPath, modelCacheRoots, PROTECTED_MODEL_CACHE_DIRS } from '../src/core/local-runtime/model-roots.js';
import { defaultStewardPolicy, runSteward } from '../src/core/steward/disk.js';

let home: string;
const now = Date.now();
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'phm-model-roots-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('protected model roots', () => {
  it('covers the HF and oMLX caches plus other weight stores, all home-relative', () => {
    for (const dir of PROTECTED_MODEL_CACHE_DIRS) {
      expect(dir.startsWith('.')).toBe(true); // never repo-relative, never absolute
    }
    expect(modelCacheRoots(home)).toContain(join(home, '.cache/huggingface'));
    expect(modelCacheRoots(home)).toContain(join(home, '.omlx'));
    expect(modelCacheRoots(home)).toContain(join(home, '.ashlr/models'));
  });

  it('recognizes paths inside model caches and rejects everything else', () => {
    expect(isProtectedModelPath(join(home, '.cache/huggingface/hub/models--mlx-community--Qwen2.5-Coder-7B-Instruct-4bit'), home)).toBe(true);
    expect(isProtectedModelPath(join(home, '.omlx/models'), home)).toBe(true);
    expect(isProtectedModelPath(join(home, '.cache/huggingface'), home)).toBe(true);
    expect(isProtectedModelPath(join(home, '.cache/huggingface-evil'), home)).toBe(false);
    expect(isProtectedModelPath(join(home, 'Projects/ashlrai/wt/job/node_modules'), home)).toBe(false);
    expect(isProtectedModelPath('relative/path', home)).toBe(false);
    expect(isProtectedModelPath(join(home, '.cache/huggingface'), 'relative-home')).toBe(false);
  });

  it('no allowlisted steward root sits inside a model cache', () => {
    for (const root of defaultStewardPolicy(home).roots) {
      expect(isProtectedModelPath(root.path, home)).toBe(false);
    }
  });
});

describe('runSteward refuses model caches even with apply', () => {
  it('a crafted policy root inside a protected dir deletes nothing', () => {
    const weights = join(home, '.cache/huggingface/hub/model.safetensors');
    mkdirSync(join(weights, '..'), { recursive: true });
    writeFileSync(weights, Buffer.alloc(1024));
    const old = (now - 60 * 86_400_000) / 1000;
    utimesSync(weights, old, old);
    const policy = {
      ...defaultStewardPolicy(home),
      roots: [{ id: 'hf-cache', path: join(home, '.cache/huggingface'), retentionDays: 0, quotaMB: 0, action: 'delete' as const }],
    };
    const report = runSteward(policy, { home, now, apply: true });
    expect(existsSync(weights)).toBe(true);
    expect(report.deleted).toEqual({ files: 0, bytes: 0 });
    // The refusal is complete: the root was never even walked.
    expect(report.roots[0]).toMatchObject({ files: 0, bytes: 0, reclaimable: { files: 0, bytes: 0 } });
  });
});

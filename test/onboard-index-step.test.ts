/**
 * `phm init` builds ~/.ashlr/index.json on first run, so `phm status` lists
 * the user's repos straight away and doctor has no "Index file present"
 * warning to report. Hermetic: tmp HOME, fresh module graph per test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig, OnboardStep } from '../src/core/types.js';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-onboard-index-'));
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('USERPROFILE', tmpHome);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function runOnboard(roots: string[]): Promise<{ step: OnboardStep; indexPath: string }> {
  const { defaultConfig, INDEX_PATH } = await import('../src/core/config.js');
  const { onboard } = await import('../src/core/onboard.js');
  const cfg: AshlrConfig = { ...defaultConfig(), roots };
  const result = await onboard(cfg, { wire: false, yes: true });
  const step = result.steps.find(s => s.name === 'index');
  if (!step) throw new Error('no index step');
  return { step, indexPath: INDEX_PATH };
}

describe('onboard — index step', () => {
  it('builds the index on first run and counts the repos under the roots', async () => {
    const root = join(tmpHome, 'code');
    mkdirSync(join(root, 'demo', '.git'), { recursive: true });
    mkdirSync(join(root, 'notes'), { recursive: true });

    const { step, indexPath } = await runOnboard([root]);

    expect(indexPath.startsWith(tmpHome)).toBe(true);
    expect(step.status).toBe('ok');
    expect(step.detail).toBe(`Indexed 1 repo under ${root}`);
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { items: Array<{ name: string }> };
    expect(index.items.map(i => i.name)).toContain('demo');
  }, 30_000);

  it('leaves an existing index alone', async () => {
    const root = join(tmpHome, 'code');
    mkdirSync(join(root, 'demo', '.git'), { recursive: true });
    mkdirSync(join(tmpHome, '.ashlr'), { recursive: true });
    const existing = JSON.stringify({ generatedAt: '2026-01-01T00:00:00.000Z', items: [] });
    writeFileSync(join(tmpHome, '.ashlr', 'index.json'), existing);

    const { step, indexPath } = await runOnboard([root]);

    expect(step.status).toBe('ok');
    expect(step.detail).toMatch(/^Index present/);
    expect(readFileSync(indexPath, 'utf8')).toBe(existing);
  }, 30_000);

  it('skips with the roots command when no roots are configured', async () => {
    const { step, indexPath } = await runOnboard([]);

    expect(step.status).toBe('skipped');
    expect(step.detail).toContain('phm config set roots');
    expect(existsSync(indexPath)).toBe(false);
  }, 30_000);
});

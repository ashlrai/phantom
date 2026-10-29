import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const { emitCycle, createCycleHooks } = createRequire(import.meta.url)('../scripts/cycle_emit.cjs');
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cycle-emit-'));
  roots.push(root);
  return { root, spoolDir: join(root, 'spool') };
}
const identity = { cycleId: 'FAKE-cycle', repo: 'ashlrai/phantom', pool: 'codex-personal', tier: 'work' };
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('router cycle spool', () => {
  it('publishes complete private records at all three hook points', () => {
    const { spoolDir } = fixture();
    const hooks = createCycleHooks(identity, { spoolDir });
    expect(hooks.S1().ok).toBe(true);
    expect(hooks.S2().ok).toBe(true);
    expect(hooks.S3({ outcome: 'success' }).ok).toBe(true);
    const files = readdirSync(spoolDir);
    expect(files).toHaveLength(3);
    const records = files.map(file => {
      expect(file).toMatch(/^[0-9a-f-]+\.json$/);
      if (process.platform !== 'win32') expect(statSync(join(spoolDir, file)).mode & 0o777).toBe(0o600);
      return JSON.parse(readFileSync(join(spoolDir, file), 'utf8'));
    });
    expect(new Set(records.map(record => record.stage))).toEqual(new Set(['S1', 'S2', 'S3']));
    for (const record of records) {
      expect(record).toMatchObject({ ...identity, schema: 'phantom.router.cycle/v1' });
      expect(new Date(record.at).toISOString()).toBe(record.at);
    }
    if (process.platform !== 'win32') expect(statSync(spoolDir).mode & 0o777).toBe(0o700);
  });

  it.each([
    { stage: 'S4' }, { cycleId: '../escape' }, { repo: '' }, { tier: null },
    { stage: 'S1', outcome: 'success' }, { stage: 'S3', outcome: 'unknown' },
    { detail: 'untrusted free text' },
  ])('rejects malformed or free-text input before writing: %j', change => {
    const { spoolDir } = fixture();
    expect(() => emitCycle({ ...identity, stage: 'S1', ...change }, { spoolDir })).toThrow();
    expect(readdirSync(join(spoolDir, '..'))).toEqual([]);
  });

  it('does not serialize runtime credentials and rejects credential fields', () => {
    const { spoolDir } = fixture();
    const FAKE = `FAKE-${randomBytes(24).toString('hex')}`;
    expect(() => emitCycle({ ...identity, stage: 'S1', key: FAKE }, { spoolDir })).toThrow();
    const result = emitCycle({ ...identity, stage: 'S1' }, { spoolDir, key: FAKE });
    expect(readFileSync(result.path, 'utf8').includes(FAKE)).toBe(false);
  });

  it('isolates spool failures from router hooks', () => {
    const { root } = fixture();
    const hooks = createCycleHooks(identity, { spoolDir: join(root, 'not-directory') });
    mkdirSync(join(root, 'target'), { mode: 0o700 });
    symlinkSync(join(root, 'target'), join(root, 'not-directory'), 'dir');
    expect(hooks.S1()).toEqual({ ok: false, reason: 'cycle-spool-failed' });
    expect(readdirSync(join(root, 'target'))).toEqual([]);
  });

  it('binds hook identity and options at creation and rejects overrides', () => {
    const { spoolDir } = fixture();
    const mutableIdentity = { ...identity };
    const options = { spoolDir };
    const hooks = createCycleHooks(mutableIdentity, options);
    mutableIdentity.cycleId = 'changed';
    options.spoolDir = 'unused';
    expect(hooks.S1({ cycleId: 'override' }).ok).toBe(false);
    expect(hooks.S1().ok).toBe(true);
    const record = JSON.parse(readFileSync(join(spoolDir, readdirSync(spoolDir)[0]!), 'utf8'));
    expect(record.cycleId).toBe(identity.cycleId);
  });

  it('refuses a publicly accessible existing spool', () => {
    if (process.platform === 'win32') return;
    const { spoolDir } = fixture();
    mkdirSync(spoolDir, { mode: 0o755 });
    expect(() => emitCycle({ ...identity, stage: 'S1' }, { spoolDir })).toThrow('unsafe spool');
    expect(readdirSync(spoolDir)).toEqual([]);
  });

  it.each(['writeFileSync', 'fsyncSync', 'linkSync'])('cleans incomplete records after %s fails', operation => {
    const { spoolDir } = fixture();
    const fs = createRequire(import.meta.url)('node:fs');
    vi.spyOn(fs, operation).mockImplementationOnce(() => { throw new Error('FAKE filesystem failure'); });
    expect(createCycleHooks(identity, { spoolDir }).S2()).toEqual({ ok: false, reason: 'cycle-spool-failed' });
    expect(readdirSync(spoolDir)).toEqual([]);
  });

  it('never overwrites repeated cycle events', () => {
    const { spoolDir } = fixture();
    const ids = new Set(Array.from({ length: 20 }, () => emitCycle({ ...identity, stage: 'S2' }, { spoolDir }).id));
    expect(ids.size).toBe(20);
    expect(readdirSync(spoolDir)).toHaveLength(20);
  });

  it('runs the stdin CLI in an isolated home without exposing invalid input', () => {
    const { root } = fixture();
    const run = (input: string) => spawnSync(process.execPath, [resolve('scripts/cycle_emit.cjs')], {
      input, timeout: 1000, encoding: 'utf8', env: { ...process.env, HOME: root, USERPROFILE: root },
    });
    const result = run(JSON.stringify({ ...identity, stage: 'S1' }));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(readdirSync(join(root, '.phantom/router/spool'))).toHaveLength(1);
    for (const input of ['invalid-json', 'x'.repeat(4097)]) {
      const failure = run(input);
      expect(failure.status).toBe(1);
      expect(failure.stdout).toBe('');
      expect(failure.stderr).toMatch(/^cycle_emit: /);
      expect(failure.stderr.includes(input)).toBe(false);
    }
  });
});

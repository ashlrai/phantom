import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../examples/skill-calibration-export.js';
import { projectSkillRoutingCalibrationSnapshot } from '../src/core/fleet/skill-routing-calibration-snapshot.js';
import { SKILL_ROUTING_CALIBRATION_POLICY_VERSION } from '../src/core/fleet/skill-routing-calibration.js';

const keys = [
  'schemaVersion', 'sourceRevision', 'routerPolicyVersion', 'sourceState', 'complete',
  'invalidRows', 'duplicateRows', 'conflictingRows', 'limitExceeded', 'skills', 'cases',
  'sourceId', 'kind', 'ownerSkillSourceId', 'excludedSkillSourceId', 'observedAt', 'textParts',
];
const fakeKey = Buffer.alloc(32, 0x47);
const fixture = {
  schemaVersion: 1,
  sourceRevision: 'revision-1',
  routerPolicyVersion: SKILL_ROUTING_CALIBRATION_POLICY_VERSION,
  sourceState: 'healthy',
  complete: true,
  invalidRows: 0,
  duplicateRows: 0,
  conflictingRows: 0,
  limitExceeded: false,
  skills: [{ sourceId: 'private-skill-canary', textParts: ['private content canary'] }],
  cases: [{
    sourceId: 'private-case-canary', kind: 'positive-owner', ownerSkillSourceId: 'private-skill-canary',
    excludedSkillSourceId: null, observedAt: '2026-07-22T11:57:00.000Z', textParts: ['private prompt canary'],
  }],
};
const encode = (value: object): Buffer => Buffer.from(JSON.stringify(value, keys));
const roots: string[] = [];

function setup(source: Buffer = encode(fixture), key: Buffer = fakeKey) {
  const root = mkdtempSync(join(tmpdir(), 'private-path-canary-'));
  roots.push(root);
  const sourcePath = join(root, 'source.json');
  const keyPath = join(root, 'projection.bin');
  writeFileSync(sourcePath, source);
  writeFileSync(keyPath, key);
  return { root, sourcePath, keyPath };
}

function invoke(args: string[]) {
  let stdout = '';
  let stderr = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true; });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true; });
  try {
    return { code: main(args), get stdout() { return stdout; }, get stderr() { return stderr; } };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('skill calibration export example', () => {
  it('emits exactly the real projector output without raw data or key material', () => {
    const source = encode(fixture);
    const { root, sourcePath, keyPath } = setup(source);
    const result = invoke(['--source', sourcePath, '--key-file', keyPath]);
    const expected = projectSkillRoutingCalibrationSnapshot(source, fakeKey);
    expect(expected.state).toBe('projected');
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(expected);
    for (const secret of ['private-skill-canary', 'private-case-canary', 'private content', 'private prompt', fakeKey.toString('hex'), root]) {
      expect(result.stdout).not.toContain(secret);
    }
    expect(invoke(['--key-file', keyPath, '--source', sourcePath]).stdout).toBe(result.stdout);
  });

  it.each([
    ['incomplete', encode({ ...fixture, complete: false }), 'source-incomplete'],
    ['malformed', Buffer.from('{private payload canary'), 'invalid-input'],
    ['noncanonical', Buffer.from(JSON.stringify(fixture, null, 2)), 'invalid-input'],
  ])('withholds %s source with the projector reason', (_label, source, reason) => {
    const { root, sourcePath, keyPath } = setup(source);
    const result = invoke(['--source', sourcePath, '--key-file', keyPath]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(projectSkillRoutingCalibrationSnapshot(source, fakeKey));
    expect(JSON.parse(result.stdout)).toMatchObject({ state: 'withheld', reason, snapshot: null });
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(root);
    expect(result.stdout).not.toContain('private');
  });

  it('withholds an incorrectly sized key and a source larger than the bound', () => {
    const badKey = setup(encode(fixture), Buffer.alloc(33, 0x47));
    const result = invoke(['--source', badKey.sourcePath, '--key-file', badKey.keyPath]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: 'withheld', reason: 'invalid-input' });
    const large = setup(Buffer.alloc(5 * 1024 * 1024 + 2, 0x61));
    const oversized = invoke(['--source', large.sourcePath, '--key-file', large.keyPath]);
    expect(oversized.code).toBe(1);
    expect(JSON.parse(oversized.stdout)).toMatchObject({ state: 'withheld', reason: 'invalid-input' });
  });

  it('rejects missing, duplicate and extra arguments without exposing them', () => {
    for (const args of [[], ['--source', 'private-path-canary'], ['--source', 'private-path-canary', '--source', 'private-key-canary'],
      ['--source', 'private-path-canary', '--key-file', 'private-key-canary', 'extra']]) {
      const result = invoke(args);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain('private');
    }
  });

  it('does not expose paths or input when a selected file cannot be read', () => {
    const { root, sourcePath, keyPath } = setup();
    for (const args of [['--source', join(root, 'missing'), '--key-file', keyPath],
      ['--source', sourcePath, '--key-file', join(root, 'missing')], ['--source', root, '--key-file', keyPath]]) {
      const result = invoke(args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('Unable to read the selected source or key file.\n');
      expect(result.stderr).not.toContain(root);
    }
  });
});

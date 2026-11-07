import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cmdFleetSkillCalibration,
  skillCalibrationPaths,
  type FleetSkillCalibrationReport,
  type SkillCalibrationFileReader,
} from '../src/cli/fleet-skill-calibration.js';
import { cmdFleet } from '../src/cli/fleet.js';
import { SKILL_ROUTING_CALIBRATION_POLICY_VERSION } from '../src/core/fleet/skill-routing-calibration.js';
import { skillRecordsDir } from '../src/core/fleet/skill-records.js';

const CANONICAL_KEYS = [
  'schemaVersion', 'sourceRevision', 'routerPolicyVersion', 'sourceState', 'complete',
  'invalidRows', 'duplicateRows', 'conflictingRows', 'limitExceeded', 'skills', 'cases',
  'sourceId', 'kind', 'ownerSkillSourceId', 'excludedSkillSourceId', 'observedAt', 'textParts',
];
const KEY = Buffer.alloc(32, 0x47);
const NOW = '2026-10-31T12:00:00.000Z';
const clock = () => new Date(NOW);

const fixture = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  sourceRevision: 'rev-2026-10-31',
  routerPolicyVersion: SKILL_ROUTING_CALIBRATION_POLICY_VERSION,
  sourceState: 'healthy',
  complete: true,
  invalidRows: 0,
  duplicateRows: 0,
  conflictingRows: 0,
  limitExceeded: false,
  skills: [
    { sourceId: 'private-skill-alpha', textParts: ['private alpha skill canary'] },
    { sourceId: 'private-skill-beta', textParts: ['private beta skill canary'] },
  ],
  cases: [
    {
      sourceId: 'private-case-one', kind: 'positive-owner', ownerSkillSourceId: 'private-skill-alpha',
      excludedSkillSourceId: null, observedAt: '2026-10-01T12:00:00.000Z', textParts: ['private prompt canary alpha'],
    },
    {
      sourceId: 'private-case-two', kind: 'negative-owner', ownerSkillSourceId: 'private-skill-alpha',
      excludedSkillSourceId: 'private-skill-beta', observedAt: '2026-10-02T12:00:00.000Z', textParts: ['private prompt canary beta'],
    },
  ],
  ...overrides,
});
const encode = (value: object): Buffer => Buffer.from(JSON.stringify(value, CANONICAL_KEYS));

type FakeInput = Buffer | 'missing' | 'unreadable';

/** An injected reader backed by an in-memory table; unknown paths read as missing. */
function fakeRead(files: Record<string, FakeInput>): { read: SkillCalibrationFileReader; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    read: (path) => {
      calls.push(path);
      const input = files[path];
      if (input === undefined || input === 'missing') return { state: 'missing' };
      if (input === 'unreadable') return { state: 'unreadable' };
      // Fresh copy: the command zeroizes the buffers it was handed.
      return { state: 'read', bytes: Buffer.from(input) };
    },
  };
}

function depsFor(files: Record<string, FakeInput>) {
  const { read, calls } = fakeRead(files);
  return { deps: { read, sourcePath: '/inputs/source.json', keyPath: '/inputs/key.bin', now: clock }, calls };
}

const okFiles = { '/inputs/source.json': encode(fixture()), '/inputs/key.bin': KEY };

let output: string[];
let errors: string;
beforeEach(() => {
  output = [];
  errors = '';
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => { output.push(String(message)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { errors += String(chunk); return true; });
});
afterEach(() => vi.restoreAllMocks());

const report = () => JSON.parse(output.join('\n')) as FleetSkillCalibrationReport;

describe('ashlr fleet skill-calibration', () => {
  it('reports a verified snapshot with skill and case counts and policy versions', async () => {
    const { deps } = depsFor(okFiles);
    expect(await cmdFleetSkillCalibration(['--json'], deps)).toBe(0);
    const r = report();
    expect(r).toMatchObject({
      v: 1,
      generatedAt: NOW,
      state: 'verified',
      verified: true,
      reason: 'snapshot-projected',
      inputs: { source: 'read', key: 'read' },
      skillCount: 2,
      caseCount: 2,
      sourceRevision: 'rev-2026-10-31',
      routerPolicyVersion: 'm450-tfidf-v1',
      projectionPolicyVersion: 'm453-token-counts-v1',
      authority: 'observation-only',
    });
    expect(errors).toBe('');
  });

  it('never prints source identifiers, private text, key bytes or input paths', async () => {
    const { deps } = depsFor(okFiles);
    expect(await cmdFleetSkillCalibration([], deps)).toBe(0);
    const text = output.join('\n');
    expect(text).toContain('verified');
    expect(text).toContain('skills: 2');
    expect(text).toContain('cases: 2');
    for (const secret of [
      'private-skill-alpha', 'private-case-one', 'private prompt', 'private alpha skill',
      KEY.toString('hex'), '/inputs/source.json', '/inputs/key.bin',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it.each([
    ['noncanonical JSON', Buffer.from(JSON.stringify(fixture(), null, 2)), 'invalid-input'],
    ['malformed JSON', Buffer.from('{private payload canary'), 'invalid-input'],
    ['a foreign router policy', encode(fixture({ routerPolicyVersion: 'm999-foreign-v1' })), 'invalid-input'],
    ['an incomplete source', encode(fixture({ complete: false })), 'source-incomplete'],
    ['a degraded source', encode(fixture({ sourceState: 'degraded' })), 'source-degraded'],
  ])('withholds %s, reports verified false and exits nonzero', async (_label, source, reason) => {
    const { deps } = depsFor({ '/inputs/source.json': source, '/inputs/key.bin': KEY });
    expect(await cmdFleetSkillCalibration(['--json'], deps)).toBe(1);
    const r = report();
    expect(r).toMatchObject({
      state: 'withheld', verified: false, reason,
      inputs: { source: 'read', key: 'read' },
      skillCount: null, caseCount: null, sourceRevision: null,
      routerPolicyVersion: null, projectionPolicyVersion: null,
    });
    expect(output.join('\n')).not.toContain('private');
  });

  it('withholds a wrongly sized key', async () => {
    const { deps } = depsFor({ '/inputs/source.json': encode(fixture()), '/inputs/key.bin': Buffer.alloc(33, 0x47) });
    expect(await cmdFleetSkillCalibration(['--json'], deps)).toBe(1);
    expect(report()).toMatchObject({ state: 'withheld', verified: false, reason: 'invalid-input' });
  });

  it.each([
    ['only the source is absent', { '/inputs/key.bin': KEY }, { source: 'missing', key: 'read' }],
    ['only the key is absent', { '/inputs/source.json': encode(fixture()) }, { source: 'read', key: 'missing' }],
    ['both inputs are absent', {}, { source: 'missing', key: 'missing' }],
  ])('reports absent when %s and never verifies', async (_label, files, inputs) => {
    const { deps } = depsFor(files);
    expect(await cmdFleetSkillCalibration(['--json'], deps)).toBe(1);
    expect(report()).toMatchObject({
      state: 'absent', verified: false, reason: 'inputs-missing', inputs,
      skillCount: null, caseCount: null,
    });
    expect(output.join('\n')).not.toContain('/inputs/');
  });

  it('reports unreadable when an input exists but cannot be read', async () => {
    const { deps } = depsFor({ '/inputs/source.json': 'unreadable', '/inputs/key.bin': KEY });
    expect(await cmdFleetSkillCalibration(['--json'], deps)).toBe(1);
    expect(report()).toMatchObject({
      state: 'unreadable', verified: false, reason: 'input-unreadable',
      inputs: { source: 'unreadable', key: 'read' },
    });
  });

  it('ranks an unreadable input above a missing one', async () => {
    const { deps } = depsFor({ '/inputs/source.json': 'unreadable' });
    expect(await cmdFleetSkillCalibration(['--json'], deps)).toBe(1);
    expect(report()).toMatchObject({
      state: 'unreadable', inputs: { source: 'unreadable', key: 'missing' },
    });
  });

  it('reads the default store locations when no paths are given or injected', async () => {
    const { read, calls } = fakeRead({});
    expect(await cmdFleetSkillCalibration(['--json'], { read, now: clock })).toBe(1);
    expect(calls).toEqual([skillCalibrationPaths().sourcePath, skillCalibrationPaths().keyPath]);
    expect(calls[0]).toBe(join(skillRecordsDir(), 'routing-calibration', 'source.json'));
    expect(report()).toMatchObject({ state: 'absent', verified: false });
  });

  it('rejects bad usage without echoing stray paths', async () => {
    const { deps } = depsFor(okFiles);
    for (const args of [
      ['--bogus'],
      ['--json', '--json'],
      ['--source'],
      ['--source', '--json'],
      ['--source', '/private/a', '--source', '/private/b'],
      ['/private/positional-path'],
    ]) {
      expect(await cmdFleetSkillCalibration(args, deps)).toBe(2);
      expect(output).toEqual([]);
      expect(errors).toContain('usage:');
      expect(errors).not.toContain('/private/');
    }
  });

  it('prints usage on --help', async () => {
    expect(await cmdFleetSkillCalibration(['--help'])).toBe(0);
    expect(output.join('\n')).toContain('ashlr fleet skill-calibration');
  });

  describe('through cmdFleet', () => {
    const roots: string[] = [];
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

    function realFiles(source: Buffer = encode(fixture())) {
      const root = mkdtempSync(join(tmpdir(), 'fleet-skill-calibration-'));
      roots.push(root);
      const sourcePath = join(root, 'source.json');
      const keyPath = join(root, 'key.bin');
      writeFileSync(sourcePath, source);
      writeFileSync(keyPath, KEY);
      return { sourcePath, keyPath };
    }

    it('verifies real source and key files end to end', async () => {
      const { sourcePath, keyPath } = realFiles();
      expect(await cmdFleet(['skill-calibration', '--source', sourcePath, '--key-file', keyPath, '--json'])).toBe(0);
      expect(report()).toMatchObject({
        state: 'verified', verified: true, skillCount: 2, caseCount: 2,
        routerPolicyVersion: 'm450-tfidf-v1', projectionPolicyVersion: 'm453-token-counts-v1',
      });
      expect(output.join('\n')).not.toContain(sourcePath);
    });

    it('exits nonzero on a tampered real source', async () => {
      const { sourcePath, keyPath } = realFiles(Buffer.from(JSON.stringify(fixture(), null, 2)));
      expect(await cmdFleet(['skill-calibration', '--source', sourcePath, '--key-file', keyPath, '--json'])).toBe(1);
      expect(report()).toMatchObject({ state: 'withheld', verified: false, reason: 'invalid-input' });
    });

    it('reports absent at the default location inside the relocated HOME', async () => {
      expect(await cmdFleet(['skill-calibration', '--json'])).toBe(1);
      expect(report()).toMatchObject({
        state: 'absent', verified: false,
        inputs: { source: 'missing', key: 'missing' },
      });
    });

    it('treats a directory passed as an input as unreadable', async () => {
      const { keyPath } = realFiles();
      const root = roots[0]!;
      expect(await cmdFleet(['skill-calibration', '--source', root, '--key-file', keyPath, '--json'])).toBe(1);
      expect(report()).toMatchObject({ state: 'unreadable', inputs: { source: 'unreadable', key: 'read' } });
    });
  });
});

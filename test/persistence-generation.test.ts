import { describe, expect, it } from 'vitest';

import {
  addPersistenceMarker,
  bindPersistenceSnapshot,
  inheritPersistenceSnapshot,
  persistenceDigest,
  persistenceSnapshot,
  stripPersistenceMarker,
} from '../src/core/util/persistence-generation.js';

describe('persistence generation markers', () => {
  it.each([1, 2, Number.MAX_SAFE_INTEGER])('round-trips revision %s without changing semantic state', revision => {
    const record = { id: 'run-1', nested: { status: 'pending' } };
    const persisted = addPersistenceMarker(record, revision);

    expect(persisted).toEqual({ ...record, _ashlrPersistence: { schemaVersion: 1, revision } });
    expect(stripPersistenceMarker(persisted)).toEqual({ record, revision });
    expect(record).not.toHaveProperty('_ashlrPersistence');
    expect(persisted.nested).toBe(record.nested);
    expect(persisted).toHaveProperty('_ashlrPersistence');
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid write revision %s', revision => {
      expect(() => addPersistenceMarker({ id: 'run-1' }, revision)).toThrow('Invalid persistence revision');
    },
  );

  it('reads legacy state as revision zero without mutating the input', () => {
    const record = Object.freeze({ id: 'legacy', revision: 7, schemaVersion: 42 });
    const stripped = stripPersistenceMarker(record);
    expect(stripped).toEqual({ record, revision: 0 });
    expect(stripped.record).not.toBe(record);
  });

  it.each([
    undefined, null, false, 1, 'marker', [],
    { schemaVersion: 2, revision: 3 },
    { schemaVersion: '1', revision: 3 },
    { revision: 3 },
    { schemaVersion: 1 },
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3'].map(revision => ({ schemaVersion: 1, revision })),
  ])('strips an invalid marker %j and treats its revision as unknown', marker => {
    const record = Object.freeze({ id: 'run-1', _ashlrPersistence: marker });
    expect(stripPersistenceMarker(record)).toEqual({ record: { id: 'run-1' }, revision: 0 });
    expect(record._ashlrPersistence).toBe(marker);
  });

  it('replaces an existing marker with the requested revision', () => {
    const record = { id: 'run-1', _ashlrPersistence: { schemaVersion: 1, revision: 8 } };
    const updated = addPersistenceMarker(record, 9);
    expect(updated._ashlrPersistence).toEqual({ schemaVersion: 1, revision: 9 });
    expect(record._ashlrPersistence.revision).toBe(8);
  });
});

describe('persistence content digests', () => {
  it('uses the standard SHA-256 digest of UTF-8 source text', () => {
    expect(persistenceDigest('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(persistenceDigest('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(persistenceDigest('é')).toBe('4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
    expect(persistenceDigest('é')).not.toBe(persistenceDigest('e\u0301'));
  });

  it('distinguishes semantically equal JSON with different persisted bytes', () => {
    const compact = '{"id":"run-1"}';
    const pretty = '{\n  "id": "run-1"\n}\n';
    expect(JSON.parse(compact)).toEqual(JSON.parse(pretty));
    expect(persistenceDigest(compact)).not.toBe(persistenceDigest(pretty));
  });
});

describe('object-bound persistence snapshots', () => {
  it('keeps snapshot metadata off the loaded record, even when frozen', () => {
    const record = Object.freeze({ id: 'run-1' });
    expect(persistenceSnapshot(record)).toBeUndefined();
    bindPersistenceSnapshot(record, 'original bytes', 4);
    expect(persistenceSnapshot(record)).toEqual({ digest: persistenceDigest('original bytes'), revision: 4 });
    expect(Reflect.ownKeys(record)).toEqual(['id']);
    expect(JSON.stringify(record)).toBe('{"id":"run-1"}');
  });

  it('does not grant snapshot authority to equal objects or implicit clones', () => {
    const record = { id: 'run-1' };
    bindPersistenceSnapshot(record, 'original bytes', 4);
    for (const clone of [{ id: 'run-1' }, { ...record }, structuredClone(record), Object.create(record) as object]) {
      expect(persistenceSnapshot(clone)).toBeUndefined();
    }
  });

  it('transfers a snapshot explicitly while retaining the source binding', () => {
    const source = { id: 'run-1' };
    const target = { ...source, status: 'resumed' };
    bindPersistenceSnapshot(source, 'original bytes', 4);
    inheritPersistenceSnapshot(source, target);
    expect(persistenceSnapshot(target)).toEqual({ digest: persistenceDigest('original bytes'), revision: 4 });
    expect(persistenceSnapshot(source)).toEqual(persistenceSnapshot(target));
  });

  it('keeps a transferred snapshot at its loaded generation when the source is rebound', () => {
    const source = {};
    const target = {};
    bindPersistenceSnapshot(source, 'old bytes', 4);
    inheritPersistenceSnapshot(source, target);
    bindPersistenceSnapshot(source, 'new bytes', 5);
    expect(persistenceSnapshot(source)).toEqual({ digest: persistenceDigest('new bytes'), revision: 5 });
    expect(persistenceSnapshot(target)).toEqual({ digest: persistenceDigest('old bytes'), revision: 4 });
  });

  it('leaves existing authority intact when the source has no snapshot', () => {
    const target = {};
    bindPersistenceSnapshot(target, 'target bytes', 2);
    inheritPersistenceSnapshot({}, target);
    expect(persistenceSnapshot(target)).toEqual({ digest: persistenceDigest('target bytes'), revision: 2 });
    const unbound = {};
    inheritPersistenceSnapshot({}, unbound);
    expect(persistenceSnapshot(unbound)).toBeUndefined();
  });

  it('replaces the target binding when explicitly inheriting a different generation', () => {
    const source = {};
    const target = {};
    bindPersistenceSnapshot(source, 'source bytes', 6);
    bindPersistenceSnapshot(target, 'target bytes', 2);
    inheritPersistenceSnapshot(source, target);
    expect(persistenceSnapshot(target)).toEqual({ digest: persistenceDigest('source bytes'), revision: 6 });
  });
});

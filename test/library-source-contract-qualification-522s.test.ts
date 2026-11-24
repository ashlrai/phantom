/**
 * Qualification of original PR #6547's Library source contract against current
 * origin/master. These tests encode what master supports TODAY at the
 * reader-to-narrower boundary: listLeaderFiles -> JSON wire -> narrowLeaderFiles
 * -> leaderFileRows. Candidate-only behavior (unavailable metadata for known
 * files above the cap) is deliberately NOT asserted here; see BRIDGE_NOTES.md.
 * Synthetic temp root only; no secret-shaped fixtures.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listLeaderFiles } from '../src/core/fleet/library-files.js';
import {
  leaderFileRows, narrowLeaderFiles, type LeaderFilesResponse,
} from '../src/web-ui/routes/verse/library/library-leader-files-model.js';

const CAP = 256 * 1024;
let root: string;
let leader: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'library-source-522s-'));
  leader = join(root, 'leader');
  mkdirSync(join(leader, 'drafts'), { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** What the server route does: serialize the reader result, the client parses it. */
async function viaWire(files?: Awaited<ReturnType<typeof listLeaderFiles>>): Promise<LeaderFilesResponse | null> {
  const list = files ?? await listLeaderFiles(root);
  return narrowLeaderFiles(JSON.parse(JSON.stringify({ v: 1, observedAt: new Date().toISOString(), files: list })));
}

describe('reader to narrower: readable file', () => {
  it('lists a readable file with a collapsed, bounded preview that survives the parser', async () => {
    writeFileSync(join(leader, 'VISION.md'), `plain   vision\n${'word '.repeat(200)}`);
    const body = await viaWire();
    expect(body).not.toBeNull();
    expect(body!.files).toHaveLength(1);
    const [file] = body!.files;
    expect(file!.name).toBe('VISION.md');
    expect(file!.preview.startsWith('plain vision word')).toBe(true);
    expect(file!.preview.length).toBeLessThanOrEqual(240);
    expect(leaderFileRows(body!.files, Date.now())[0]).toMatchObject({ key: 'VISION.md', label: 'Vision' });
  });

  it('reads a file of exactly the cap but never one byte more', async () => {
    writeFileSync(join(leader, 'VISION.md'), 'a'.repeat(CAP));
    writeFileSync(join(leader, 'PLAN-LOG.md'), 'a'.repeat(CAP + 1));
    const names = (await listLeaderFiles(root)).map(f => f.name);
    expect(names).toContain('VISION.md');
    expect(names).not.toContain('PLAN-LOG.md');
  });
});

describe('reader to narrower: known file above the cap (master contract)', () => {
  it('master omits the oversized file entirely: no name, size or flag reaches the wire', async () => {
    writeFileSync(join(leader, 'PLAN-LOG.md'), 'x'.repeat(CAP + 1));
    const files = await listLeaderFiles(root);
    expect(files).toEqual([]);
    expect(JSON.stringify(files)).not.toContain('PLAN-LOG');
  });

  it('master cannot tell this apart from a genuinely empty Library: both narrow to the same body', async () => {
    writeFileSync(join(leader, 'PLAN-LOG.md'), 'x'.repeat(CAP + 1));
    const oversized = await viaWire();
    rmSync(join(leader, 'PLAN-LOG.md'));
    const empty = await viaWire();
    expect(oversized).not.toBeNull();
    expect(oversized!.files).toEqual([]);
    expect(oversized!.state).toBeUndefined();
    expect({ ...oversized, observedAt: '' }).toEqual({ ...empty, observedAt: '' });
  });

  it('the oversized file does not hide a readable sibling', async () => {
    writeFileSync(join(leader, 'PLAN-LOG.md'), 'x'.repeat(CAP + 1));
    writeFileSync(join(leader, 'VISION.md'), 'ok');
    expect((await listLeaderFiles(root)).map(f => f.name)).toEqual(['VISION.md']);
  });
});

describe('reader to narrower: missing and unreadable sources', () => {
  it('a missing file is simply absent', async () => {
    writeFileSync(join(leader, 'VISION.md'), 'ok');
    expect((await listLeaderFiles(root)).map(f => f.name)).toEqual(['VISION.md']);
  });

  it('a missing leader directory yields an empty list', async () => {
    expect(await listLeaderFiles(join(root, 'nope'))).toEqual([]);
  });

  it('no-follow: a symlinked file is never read or listed', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'library-source-522s-out-'));
    try {
      writeFileSync(join(outside, 'target.md'), 'outside content');
      symlinkSync(join(outside, 'target.md'), join(leader, 'VISION.md'));
      symlinkSync(join(outside, 'target.md'), join(leader, 'drafts', 'd.md'));
      const files = await listLeaderFiles(root);
      expect(files).toEqual([]);
      expect(JSON.stringify(files)).not.toContain('outside content');
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it('a symlinked leader directory is refused', async () => {
    const real = mkdtempSync(join(tmpdir(), 'library-source-522s-real-'));
    const linked = mkdtempSync(join(tmpdir(), 'library-source-522s-link-'));
    try {
      writeFileSync(join(real, 'VISION.md'), 'ok');
      symlinkSync(real, join(linked, 'leader'));
      expect(await listLeaderFiles(linked)).toEqual([]);
    } finally {
      rmSync(real, { recursive: true, force: true });
      rmSync(linked, { recursive: true, force: true });
    }
  });

  it('a directory where a file should be is not listed', async () => {
    mkdirSync(join(leader, 'VISION.md'));
    expect(await listLeaderFiles(root)).toEqual([]);
  });
});

describe('narrower: whole-response validation and the unavailable field', () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({ name: 'VISION.md', size: 1, modifiedAt: '2026-11-09T10:00:00.000Z', preview: 'p', ...over });
  const wire = (files: unknown[], extra: Record<string, unknown> = {}) =>
    ({ v: 1, observedAt: '2026-11-09T12:00:00.000Z', files, ...extra });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['array body', []],
    ['wrong version', { ...wire([]), v: 2 }],
    ['files not an array', wire([], { files: {} })],
    ['one bad row poisons the whole body', wire([row(), row({ name: '/abs/path.md' })])],
    ['traversal name', wire([row({ name: 'drafts/../x.md' })])],
    ['negative size', wire([row({ size: -1 })])],
    ['oversized preview', wire([row({ preview: 'x'.repeat(241) })])],
    ['state with files', wire([row()], { state: 'absent' })],
    ['unknown state', wire([], { state: 'weird' })],
  ])('rejects %s whole, never as a partial or empty list', (_n, input) => {
    expect(narrowLeaderFiles(input)).toBeNull();
  });

  it('accepts both explicit empty states, distinct from each other', () => {
    expect(narrowLeaderFiles(wire([], { state: 'absent' }))?.state).toBe('absent');
    expect(narrowLeaderFiles(wire([], { state: 'unavailable' }))?.state).toBe('unavailable');
  });

  it('master does not model per-file unavailability: an extra flag passes through the parser but rows render the empty preview', () => {
    const body = narrowLeaderFiles(wire([row({ preview: '', unavailable: true })]));
    expect(body).not.toBeNull();
    expect((body!.files[0] as unknown as Record<string, unknown>).unavailable).toBe(true);
    // Master rows ignore the flag, so an unreadable file looks like an empty one.
    expect(leaderFileRows(body!.files, Date.parse('2026-11-09T12:00:00.000Z'))[0]!.preview).toBe('');
    // And master does not validate the flag's type.
    expect(narrowLeaderFiles(wire([row({ unavailable: 'yes' })]))).not.toBeNull();
  });
});

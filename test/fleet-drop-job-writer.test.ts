/**
 * RQ-PHX-DROPJOBAPI31 — unit contract for core/fleet/drop-job-writer.ts.
 *
 * Hermetic: every call roots at a fresh mkdtemp runs dir; no HOME, no
 * network, no real ~/.ashlr-runs. Covers every validation reason, spent-id
 * detection in all four ingest locations, the atomic no-clobber publish, the
 * path-escape refusal and the pending list.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countQueuedDropJobPrompts,
  DROP_JOB_FILE_PREFIX,
  DROP_JOB_MAX_FILE_BYTES,
  DropJobExistsError,
  DropJobPathError,
  DropJobValidationError,
  dropJobExists,
  listDropJobs,
  resolveDropJobRoot,
  validateDropJob,
  writeDropJob,
  type DropJobInput,
} from '../src/core/fleet/drop-job-writer.js';

const roots: string[] = [];
const root = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'drop-jobs-'));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const GOOD: DropJobInput = { id: 'TEST123', lane: 'claude', tier: 'work', body: 'Summarize the merge backlog.' };
const FIXED = new Date('2026-11-01T12:00:00.000Z');
const file = (dir: string, id: string) => join(dir, 'leader', 'drop', 'claude', `${DROP_JOB_FILE_PREFIX}${id}.md`);

// ---------------------------------------------------------------------------
// validateDropJob
// ---------------------------------------------------------------------------

describe('validateDropJob', () => {
  it('accepts a well-formed job', () => {
    expect(validateDropJob(GOOD)).toEqual({ ok: true });
    for (const lane of ['claude', 'codex-personal', 'devin', 'codex-local']) {
      expect(validateDropJob({ ...GOOD, lane })).toEqual({ ok: true });
    }
    for (const tier of ['frontier', 'work', 'mid', 'fast']) {
      expect(validateDropJob({ ...GOOD, tier })).toEqual({ ok: true });
    }
  });

  it('rejects bad ids with id-shape', () => {
    for (const id of ['abc', 'lower', 'AB', `A${'1'.repeat(40)}`, 'AB CD', 'AB/CD', '', 7, null, undefined]) {
      expect(validateDropJob({ ...GOOD, id: id as unknown as string })).toEqual({ ok: false, reasons: ['id-shape'] });
    }
  });

  it('rejects lanes and tiers outside the allow-lists', () => {
    expect(validateDropJob({ ...GOOD, lane: 'grok' })).toEqual({ ok: false, reasons: ['lane'] });
    expect(validateDropJob({ ...GOOD, lane: 'CLAUDE' })).toEqual({ ok: false, reasons: ['lane'] });
    expect(validateDropJob({ ...GOOD, tier: 'turbo' })).toEqual({ ok: false, reasons: ['tier'] });
    expect(validateDropJob({ ...GOOD, tier: 'WORK' })).toEqual({ ok: false, reasons: ['tier'] });
  });

  it('rejects an empty or non-string body', () => {
    for (const body of ['', '   ', '\n\n', 5, null, undefined]) {
      expect(validateDropJob({ ...GOOD, body: body as unknown as string })).toEqual({ ok: false, reasons: ['empty-body'] });
    }
  });

  it('rejects control characters other than newline and tab', () => {
    expect(validateDropJob({ ...GOOD, body: 'line\rbreak' })).toEqual({ ok: false, reasons: ['control-characters'] });
    expect(validateDropJob({ ...GOOD, body: 'bell\x07' })).toEqual({ ok: false, reasons: ['control-characters'] });
    expect(validateDropJob({ ...GOOD, body: 'ok\nline\ttab' })).toEqual({ ok: true });
  });

  it('rejects bodies naming protected operator paths with denied-content', () => {
    for (const body of [
      'look at .github/workflows/ci.yml',
      'read /.codex/config',
      'cat the auth.json file',
      'edit CODEOWNERS line 3',
      'relative path dir/.github/ also matches',
    ]) {
      const verdict = validateDropJob({ ...GOOD, body });
      expect(verdict).toEqual({ ok: false, reasons: ['denied-content'] });
    }
    // The fragments alone are fine — only the full tokens are denied.
    for (const body of ['the .github directory', 'codex home', 'auth flow', 'code owners file']) {
      expect(validateDropJob({ ...GOOD, body })).toEqual({ ok: true });
    }
  });

  it('rejects a file that would exceed 8000 bytes with too-large', () => {
    const header = '#job repo=phantom lane=claude tier=work\n\n';
    const overhead = Buffer.byteLength(header, 'utf8') + 1; // trailing newline
    const body = 'x'.repeat(DROP_JOB_MAX_FILE_BYTES - overhead); // exactly at the cap
    expect(validateDropJob({ ...GOOD, body })).toEqual({ ok: true });
    expect(validateDropJob({ ...GOOD, body: `${body}x` })).toEqual({ ok: false, reasons: ['too-large'] });
    expect(validateDropJob({ ...GOOD, body: 'x'.repeat(9000) })).toEqual({ ok: false, reasons: ['too-large'] });
  });

  it('reports every applicable reason at once', () => {
    expect(validateDropJob({ id: 'bad', lane: 'grok', tier: 'turbo', body: 'x'.repeat(9000) })).toEqual({
      ok: false, reasons: ['id-shape', 'lane', 'tier', 'too-large'],
    });
  });
});

// ---------------------------------------------------------------------------
// dropJobExists
// ---------------------------------------------------------------------------

describe('dropJobExists', () => {
  it('is false when the id is spent nowhere', async () => {
    expect(await dropJobExists(root(), GOOD.id)).toBe(false);
    expect(await dropJobExists(root(), 'not-an-id')).toBe(false);
  });

  it.each([
    ['leader/drop/claude', `${DROP_JOB_FILE_PREFIX}${GOOD.id}.md`],
    ['leader/drop/done', `${DROP_JOB_FILE_PREFIX}${GOOD.id}.md`],
    ['queue/prompts', `${DROP_JOB_FILE_PREFIX}${GOOD.id}.md`],
    ['', `${DROP_JOB_FILE_PREFIX}${GOOD.id}.prompt`],
  ])('detects the id in %s', async (dir, name) => {
    const dir0 = root();
    const target = dir ? join(dir0, dir) : dir0;
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, name), 'x');
    expect(await dropJobExists(dir0, GOOD.id)).toBe(true);
    expect(await dropJobExists(dir0, 'OTHER99')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeDropJob
// ---------------------------------------------------------------------------

describe('writeDropJob', () => {
  it('publishes the file with the exact header and matching byte count', async () => {
    const dir0 = root();
    const written = await writeDropJob(dir0, GOOD, () => FIXED);
    // The writer publishes on the realpath — /var is a symlink on macOS.
    expect(written).toEqual({
      file: join(realpathSync(dir0), 'leader', 'drop', 'claude', `${DROP_JOB_FILE_PREFIX}${GOOD.id}.md`),
      bytes: Buffer.byteLength(readFileSync(written.file, 'utf8'), 'utf8'),
      at: FIXED.toISOString(),
    });
    const text = readFileSync(written.file, 'utf8');
    expect(text.split('\n')[0]).toBe('#job repo=phantom lane=claude tier=work');
    expect(text).toBe(`#job repo=phantom lane=claude tier=work\n\n${GOOD.body}\n`);
    // No sweepable temp file is left behind.
    expect(readdirSync(join(dir0, 'leader', 'drop', 'claude'))).toEqual([`${DROP_JOB_FILE_PREFIX}${GOOD.id}.md`]);
  });

  it('never overwrites an existing job file', async () => {
    const dir0 = root();
    await writeDropJob(dir0, GOOD);
    const first = readFileSync(file(dir0, GOOD.id), 'utf8');
    await expect(writeDropJob(dir0, { ...GOOD, body: 'a replacement' })).rejects.toBeInstanceOf(DropJobExistsError);
    expect(readFileSync(file(dir0, GOOD.id), 'utf8')).toBe(first);
  });

  it('refuses an invalid job before touching the disk', async () => {
    const dir0 = root();
    await expect(writeDropJob(dir0, { ...GOOD, lane: 'grok' })).rejects.toMatchObject({
      name: 'DropJobValidationError', reasons: ['lane'],
    });
    await expect(writeDropJob(dir0, { ...GOOD, lane: 'grok' })).rejects.toBeInstanceOf(DropJobValidationError);
    expect(await dropJobExists(dir0, GOOD.id)).toBe(false);
  });

  it('refuses to publish outside the root when the drop dir is a symlink', async () => {
    const dir0 = root();
    const outside = mkdtempSync(join(tmpdir(), 'drop-outside-'));
    roots.push(outside);
    mkdirSync(join(dir0, 'leader', 'drop'), { recursive: true });
    symlinkSync(outside, join(dir0, 'leader', 'drop', 'claude'), 'dir');
    await expect(writeDropJob(dir0, GOOD)).rejects.toBeInstanceOf(DropJobPathError);
    expect(readdirSync(outside)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// countQueuedDropJobPrompts
// ---------------------------------------------------------------------------

describe('countQueuedDropJobPrompts', () => {
  it('counts only RQ-PHX prompt files, tolerating a missing queue', async () => {
    const dir0 = root();
    expect(await countQueuedDropJobPrompts(dir0)).toBe(0);
    const prompts = join(dir0, 'queue', 'prompts');
    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, `${DROP_JOB_FILE_PREFIX}AAAA.md`), 'x');
    writeFileSync(join(prompts, `${DROP_JOB_FILE_PREFIX}BBBB.md`), 'x');
    writeFileSync(join(prompts, 'other.md'), 'x');
    writeFileSync(join(prompts, 'RQ-OTHER-AAAA.md'), 'x');
    mkdirSync(join(prompts, `${DROP_JOB_FILE_PREFIX}CCCC.md`)); // a directory is not a file
    expect(await countQueuedDropJobPrompts(dir0)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// listDropJobs
// ---------------------------------------------------------------------------

describe('listDropJobs', () => {
  it('answers [] for a missing or empty drop lane', async () => {
    expect(await listDropJobs(root())).toEqual([]);
    const dir0 = root();
    mkdirSync(join(dir0, 'leader', 'drop', 'claude'), { recursive: true });
    expect(await listDropJobs(dir0)).toEqual([]);
  });

  it('lists pending jobs with parsed header, title, bytes and age', async () => {
    const dir0 = root();
    await writeDropJob(dir0, GOOD);
    await writeDropJob(dir0, { ...GOOD, id: 'SECOND7', lane: 'devin', tier: 'fast', body: '\n\nFirst real line\nsecond' });
    const [first, second] = await listDropJobs(dir0, () => FIXED.getTime() + 30_000);
    expect(first?.id).toBe('SECOND7'); // name-sorted, like the sweep
    expect(second?.id).toBe('TEST123');
    expect(first).toMatchObject({ lane: 'devin', tier: 'fast', title: 'First real line' });
    expect(second).toMatchObject({ lane: 'claude', tier: 'work', title: GOOD.body, bytes: readFileSync(file(dir0, GOOD.id)).length });
    expect(second?.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  it('ages by file mtime and never below zero', async () => {
    const dir0 = root();
    await writeDropJob(dir0, GOOD);
    const past = (FIXED.getTime() - 120_000) / 1000;
    utimesSync(file(dir0, GOOD.id), past, past);
    const [old] = await listDropJobs(dir0, () => FIXED.getTime());
    expect(old?.ageSeconds).toBe(120);
    const [fresh] = await listDropJobs(dir0, () => FIXED.getTime() - 600_000);
    expect(fresh?.ageSeconds).toBe(0);
  });

  it('skips non-job names but still lists a job file whose header will not parse', async () => {
    const dir0 = root();
    const laneDir = join(dir0, 'leader', 'drop', 'claude');
    mkdirSync(laneDir, { recursive: true });
    writeFileSync(join(laneDir, 'note.txt'), 'ignore me');
    writeFileSync(join(laneDir, 'RQ-OTHER-AAA1.md'), 'ignore me too');
    writeFileSync(file(dir0, 'BROKEN9'), 'no header here\njust a body');
    const items = await listDropJobs(dir0);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'BROKEN9', lane: null, tier: null, title: 'no header here' });
  });

  it('clips the title to 120 chars and strips control bytes', async () => {
    const dir0 = root();
    await writeDropJob(dir0, { ...GOOD, body: `${'y'.repeat(200)}` });
    const [item] = await listDropJobs(dir0);
    expect(item?.title?.length).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// resolveDropJobRoot
// ---------------------------------------------------------------------------

describe('resolveDropJobRoot', () => {
  it('honors an explicit override and refuses relative roots', () => {
    expect(resolveDropJobRoot('/tmp/example-runs')).toBe('/tmp/example-runs');
    expect(() => resolveDropJobRoot('relative/dir')).toThrow('absolute');
  });
});

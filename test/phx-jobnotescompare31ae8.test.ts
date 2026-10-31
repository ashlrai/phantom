import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runJobPairCompare } from '../examples/agents/job-pair-compare.js';
import { getFleetJobChanges } from '../src/core/fleet/runs-job-changes.js';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';
import { getFleetJobText } from '../src/core/fleet/runs-job-texts.js';

const before = 'FAKE-BEFORE', after = 'FAKE-AFTER';
let runsDir: string;
beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'fake-job-notes-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

async function compare(options: { withNotes?: boolean; maxBytes?: number; failJob?: string } = {}) {
  let output = '';
  const readNotes = vi.fn(async (job: string, kind: 'notes') => {
    if (job === options.failJob) throw new Error('/fake/private/error');
    return getFleetJobText(job, kind, { runsDir, maxBytes: options.maxBytes });
  });
  const code = await runJobPairCompare([
    '--before', before, ...(options.withNotes ? ['--with-notes'] : []), '--after', after,
  ], {
    readDetail: job => getFleetJobDetail(job, { runsDir, now: () => new Date('2026-01-01T00:00:00Z') }),
    readChanges: job => getFleetJobChanges(job, { runsDir, homeDir: runsDir }),
    readNotes,
    write: text => { output += text; },
  });
  return { code, value: JSON.parse(output), output, readNotes };
}

describe('job pair notes comparison', () => {
  it('compares distinct nonblank lines in source order alongside artifact facts', async () => {
    await writeFile(join(runsDir, `${before}.notes.md`), 'shared\nold one\nold one\n  \nold two\n');
    await writeFile(join(runsDir, `${after}.notes.md`), 'shared\nnew one\nnew one\nnew two\n');
    await writeFile(join(runsDir, `${after}.publish`), 'RESULT PR https://example.invalid/pull/3\nTEST failed\n');
    const result = await compare({ withNotes: true });
    expect(result.code).toBe(0);
    expect(result.readNotes.mock.calls).toEqual([[before, 'notes'], [after, 'notes']]);
    expect(result.value).toMatchObject({
      before: { artifactState: 'unknown', testLine: null },
      after: { artifactState: 'published', testLine: 'TEST failed', prUrl: 'https://example.invalid/pull/3' },
      notes: { before: { state: 'ok', truncated: false }, after: { state: 'ok', truncated: false },
        complete: true, added: ['new one', 'new two'], removed: ['old one', 'old two'],
        addedOmitted: 0, removedOmitted: 0 },
    });
    expect(result.value).not.toHaveProperty('success');
    expect(result.value.after).not.toHaveProperty('verdict');
  });

  it('keeps artifact facts and reports missing, unreadable, and thrown sources as partial', async () => {
    await writeFile(join(runsDir, `${after}.notes.md`), 'observed claim\n');
    let result = await compare({ withNotes: true });
    expect(result.code).toBe(0);
    expect(result.value.notes).toMatchObject({ before: { state: 'missing', truncated: false },
      after: { state: 'ok' }, complete: false, added: ['observed claim'], removed: [] });
    expect(result.value.changedFiles).toBeDefined();

    await mkdir(join(runsDir, `${before}.notes.md`));
    result = await compare({ withNotes: true });
    expect(result.value.notes.before.state).toBe('unreadable');
    expect(result.value.notes.complete).toBe(false);
    result = await compare({ withNotes: true, failJob: after });
    expect(result.code).toBe(0);
    expect(result.value.notes.after.state).toBe('unreadable');
    expect(result.output).not.toContain('/fake/private/error');
  });

  it('reports byte truncation and bounds each direction with distinct omission counts', async () => {
    const old = Array.from({ length: 43 }, (_, i) => `old line ${i}`);
    const current = Array.from({ length: 42 }, (_, i) => `new line ${i}`);
    await writeFile(join(runsDir, `${before}.notes.md`), [...old, old[0]].join('\n'));
    await writeFile(join(runsDir, `${after}.notes.md`), [...current, current[0]].join('\n'));
    let result = await compare({ withNotes: true });
    expect(result.value.notes).toMatchObject({ complete: true, removed: old.slice(0, 40),
      added: current.slice(0, 40), removedOmitted: 3, addedOmitted: 2 });
    result = await compare({ withNotes: true, maxBytes: 10 });
    expect(result.value.notes).toMatchObject({ before: { state: 'ok', truncated: true },
      after: { state: 'ok', truncated: true }, complete: false });
  });

  it('preserves reader redaction and scrubs home paths before comparing lines', async () => {
    await writeFile(join(runsDir, `${before}.notes.md`), 'shared\n');
    await writeFile(join(runsDir, `${after}.notes.md`), 'shared\ntoken=fake-demo-value\n/Users/fake-person/work\n');
    const result = await compare({ withNotes: true });
    expect(result.value.notes.added).toContain('token=…');
    expect(result.output).not.toContain('fake-demo-value');
    expect(result.output).not.toContain('/Users/fake-person/work');
  });

  it('does not read notes by default and rejects duplicate flags before reading', async () => {
    const result = await compare();
    expect(result.code).toBe(0);
    expect(result.readNotes).not.toHaveBeenCalled();
    expect(result.value).not.toHaveProperty('notes');
    const readNotes = vi.fn();
    let output = '';
    expect(await runJobPairCompare(['--with-notes', '--before', before, '--after', after, '--with-notes'], {
      readNotes, write: text => { output += text; },
    })).toBe(2);
    expect(JSON.parse(output).error).toBe('invalid_arguments');
    expect(readNotes).not.toHaveBeenCalled();
  });
});

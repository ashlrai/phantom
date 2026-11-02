import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdReflect } from '../src/cli/reflect.js';
import { readHarnessDigest } from '../src/core/learn/harness-digest-reader.js';

// Day-one 3.30.0 workflow: an agent drops a temporary learning digest on disk
// (dated HTTPS citations, license evidence, actionable takeaways), then selects
// and freshness-gates it through `phm reflect harness-digest --source …
// --with-takeaways … [--check]`. The path is local — cited URLs are never fetched.
const NOW = new Date('2026-10-31T00:36:00Z');
const DAY_MS = 86_400_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-citation-contract-'));
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv('HOME', dir);
  vi.stubEnv('ASHLR_HOME', join(dir, 'ashlr-home'));
  vi.stubEnv('TMPDIR', dir);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function file(name: string, markdown: string): string {
  const path = join(dir, name);
  writeFileSync(path, markdown);
  return path;
}
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '', err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true; });
  try { return { code: await cmdReflect(['harness-digest', ...args]), out, err }; }
  finally { stdout.mockRestore(); stderr.mockRestore(); }
}

// The digest an agent writes on day one: two learnings with dated citations,
// license evidence and takeaways, one citation-only record, and a fenced
// example that must never be read as evidence.
function digest(): string {
  return [
    '# Harness learnings — 3.30.0 research',
    '',
    '## S1 — Citation contract survives upgrades',
    '- Checked: 2026-10-31.',
    '- Source: [Upgrade notes](https://harness.example.test/upgrade-notes) and [Digest guide](https://harness.example.test/digest-guide).',
    '- License: MIT',
    '- License source: [LICENSE](https://harness.example.test/license)',
    '- Takeaway: Gate harness-digest --check on digest files before trusting them.',
    '  Re-check after every harness upgrade.',
    '',
    '## S2 — Vendor study pending re-verification',
    '- Checked: 2026-10-20.',
    '- Source: [Old benchmark](https://vendor.example.test/old-benchmark)',
    '- License: Apache-2.0',
    '- License source: https://vendor.example.test/LICENSE.txt',
    '- Takeaway: Re-verify the benchmark claims before citing them again.',
    '',
    '## S3 — Reference without a learning',
    '- Checked: 2026-10-31.',
    '- Source: [Reference](https://docs.example.test/reference)',
    '- License: CC-BY-4.0',
    '- License source: [terms](https://docs.example.test/terms)',
    '',
    '```markdown',
    '## S7 — Fenced example, not evidence',
    '- Checked: 2026-10-31.',
    '- Source: [Fake](https://fake.example.test/source)',
    '- License: Fake',
    '- License source: [fake](https://fake.example.test/license)',
    '- Takeaway: Fenced text must not become a citation.',
    '```',
    '',
  ].join('\n');
}

const s1 = { id: 'S1', title: 'Citation contract survives upgrades', checkedAt: '2026-10-31',
  urls: ['https://harness.example.test/upgrade-notes', 'https://harness.example.test/digest-guide'],
  stale: false, license: 'MIT', licenseUrls: ['https://harness.example.test/license'],
  takeaways: ['Gate harness-digest --check on digest files before trusting them.\nRe-check after every harness upgrade.'] };
const s2 = { id: 'S2', title: 'Vendor study pending re-verification', checkedAt: '2026-10-20',
  urls: ['https://vendor.example.test/old-benchmark'], stale: true, license: 'Apache-2.0',
  licenseUrls: ['https://vendor.example.test/LICENSE.txt'],
  takeaways: ['Re-verify the benchmark claims before citing them again.'] };
const s3 = { id: 'S3', title: 'Reference without a learning', checkedAt: '2026-10-31',
  urls: ['https://docs.example.test/reference'], stale: false, license: 'CC-BY-4.0',
  licenseUrls: ['https://docs.example.test/terms'] };

describe('harness citation contract: research to machine-readable learning', () => {
  it('carries dated citations, license evidence and takeaways through --source and --with-takeaways', async () => {
    const path = file('digest.md', digest());
    const bytes = readFileSync(path);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    // The reader and the unfiltered CLI agree on the same real file, and the
    // fenced S7 block never becomes a source or a citation.
    expect(readHarnessDigest(path, new Date())).toEqual({ v: 1, sources: [s1, s2, s3], issues: [] });
    const full = await run(['--file', path, '--json']);
    expect(full).toMatchObject({ code: 0, err: '' });
    expect(JSON.parse(full.out)).toEqual({ v: 1, sources: [s1, s2, s3], issues: [] });
    expect(full.out).not.toContain('fake.example.test');
    expect(full.out).not.toContain('"S7"');

    // The day-one selection: both actionable learnings, requested out of file
    // order, keep every field the agent needs downstream.
    const args = ['--file', path, '--json', '--source', 'S2', '--source', 'S1', '--with-takeaways'];
    const selected = await run(args);
    expect(selected).toMatchObject({ code: 0, err: '' });
    expect(selected.out.endsWith('\n')).toBe(true);
    expect(JSON.parse(selected.out)).toEqual({ v: 1, sources: [s1, s2], issues: [], requestedSourceIds: ['S2', 'S1'] });
    expect(fetch).not.toHaveBeenCalled();

    // The emitted selection is a stable artifact and the digest on disk is
    // read-only state: identical re-run, byte-identical file, no side writes.
    expect((await run(args)).out).toBe(selected.out);
    expect(readFileSync(path)).toEqual(bytes);
    expect(readdirSync(dir)).toEqual(['digest.md']);
  });

  it('scopes the selection to one source and drops citation-only records from the actionable view', async () => {
    const path = file('digest.md', digest());
    const single = await run(['--file', path, '--json', '--source', 'S1', '--with-takeaways']);
    expect(single).toMatchObject({ code: 0, err: '' });
    const parsed = JSON.parse(single.out);
    expect(parsed).toEqual({ v: 1, sources: [s1], issues: [] });
    expect(parsed).not.toHaveProperty('requestedSourceIds');

    // S3 is real evidence but carries no learning: the actionable view is
    // empty, and the check treats an empty selection as not usable.
    expect((await run(['--file', path, '--json', '--source', 'S3', '--with-takeaways']))).toMatchObject({ code: 0 });
    const empty = await run(['--file', path, '--json', '--source', 'S3', '--with-takeaways', '--check']);
    expect(empty.code).toBe(1);
    expect(JSON.parse(empty.out)).toEqual({ v: 1, sources: [], issues: [] });
  });

  it('passes --check on fresh evidence and fails it on stale evidence through the same selection', async () => {
    const path = file('digest.md', digest());
    const fresh = await run(['--file', path, '--json', '--source', 'S1', '--with-takeaways', '--check']);
    expect(fresh).toMatchObject({ code: 0, err: '' });
    expect(JSON.parse(fresh.out).sources).toEqual([s1]);

    const mixed = ['--file', path, '--json', '--source', 'S1', '--source', 'S2', '--with-takeaways'];
    const normal = await run(mixed);
    const checked = await run([...mixed, '--check']);
    expect(normal).toMatchObject({ code: 0 });
    // Failing the freshness check still emits the same machine-readable selection.
    expect(checked).toEqual({ code: 1, out: normal.out, err: '' });
    expect(JSON.parse(checked.out).sources.map((source: { stale: boolean }) => source.stale)).toEqual([false, true]);

    // The same stale evidence passes again under an operator-chosen window.
    const wider = await run([...mixed, '--check', '--stale-days', '30']);
    expect(wider).toMatchObject({ code: 0 });
    expect(JSON.parse(wider.out).sources.map((source: { stale: boolean }) => source.stale)).toEqual([false, false]);
  });

  it('gives fenced fake source text no citations, no takeaways and no check credit', async () => {
    const path = file('fenced.md', [
      '## S1 — Real source',
      '- Checked: 2026-10-31.',
      '- Source: [real](https://real.example.test/doc)',
      '```markdown',
      '## S2 — Fenced fake source',
      '- Checked: 2026-10-31.',
      '- Source: [fake](https://fake.example.test/doc)',
      '- License: Fake',
      '- Takeaway: This fenced note is not a learning.',
      '```',
      '## S3 — Real tail',
      '- Checked: 2026-10-31.',
      '- Source: [tail](https://real.example.test/tail)',
      '~~~',
      '## S4 — Tilde-fenced fake',
      '- Source: [fake](https://fake2.example.test/doc)',
      '~~~',
    ].join('\n'));
    const listed = await run(['--file', path, '--json']);
    expect(listed).toMatchObject({ code: 0, err: '' });
    expect(JSON.parse(listed.out)).toEqual({ v: 1, sources: [
      { id: 'S1', title: 'Real source', checkedAt: '2026-10-31', urls: ['https://real.example.test/doc'], stale: false },
      { id: 'S3', title: 'Real tail', checkedAt: '2026-10-31', urls: ['https://real.example.test/tail'], stale: false },
    ], issues: [] });
    expect(listed.out).not.toContain('fake.example.test');
    expect(listed.out).not.toContain('fake2.example.test');

    // A fenced ID is absent from the digest: selection stays empty and --check
    // fails rather than crediting example text as evidence.
    expect((await run(['--file', path, '--json', '--source', 'S4', '--with-takeaways']))).toMatchObject({ code: 0 });
    const credit = await run(['--file', path, '--json', '--source', 'S4', '--with-takeaways', '--check']);
    expect(credit.code).toBe(1);
    expect(JSON.parse(credit.out)).toEqual({ v: 1, sources: [], issues: [] });

    // The fenced takeaway does not count as actionable for its neighbor, and
    // the fenced license does not become license evidence.
    const actionable = await run(['--file', path, '--json', '--with-takeaways', '--check']);
    expect(actionable.code).toBe(1);
    expect(JSON.parse(actionable.out)).toEqual({ v: 1, sources: [], issues: [] });
    expect(await run(['--file', path, '--json', '--source', 'S1', '--check'])).toMatchObject({ code: 0 });
  });

  it('holds through the spawned CLI with an isolated home and an unchanged digest', () => {
    vi.useRealTimers(); // The child process reads the real clock.
    const day = (offset: number) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
    const markdown = [
      '## S1 — Fresh learning', `- Checked: ${day(-2)}.`,
      '- Source: [doc](https://spawn.example.test/doc)', '- License: MIT',
      '- License source: [license](https://spawn.example.test/license)',
      '- Takeaway: Keep the citation gate on.', '',
      '```markdown', '## S9 — Fenced example', `- Checked: ${day(0)}.`,
      '- Source: [fake](https://fake.example.test/doc)', '```', '',
    ].join('\n');
    const path = file('digest.md', markdown);
    const bytes = readFileSync(path);
    const invoke = (args: string[]) => spawnSync(process.execPath,
      ['--import', 'tsx', resolve('src/cli/index.ts'), 'reflect', 'harness-digest', ...args],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, NO_COLOR: '1' } });

    const fresh = invoke(['--file', path, '--json', '--source', 'S1', '--with-takeaways', '--check']);
    expect(fresh.error).toBeUndefined();
    expect(fresh.status).toBe(0);
    expect(fresh.stderr).toBe('');
    expect(JSON.parse(fresh.stdout)).toEqual({ v: 1, sources: [{
      id: 'S1', title: 'Fresh learning', checkedAt: day(-2),
      urls: ['https://spawn.example.test/doc'], stale: false, license: 'MIT',
      licenseUrls: ['https://spawn.example.test/license'], takeaways: ['Keep the citation gate on.'] }],
    issues: [] });
    expect(fresh.stdout).not.toContain('fake.example.test');
    expect(fresh.stdout).not.toContain('"S9"');

    const stalePath = file('stale.md', markdown.replace(`- Checked: ${day(-2)}.`, `- Checked: ${day(-30)}.`));
    const stale = invoke(['--file', stalePath, '--json', '--source', 'S1', '--with-takeaways', '--check']);
    expect(stale.error).toBeUndefined();
    expect(stale.status).toBe(1);
    expect(stale.stderr).toBe('');
    const staleParsed = JSON.parse(stale.stdout);
    expect(staleParsed.sources).toHaveLength(1);
    expect(staleParsed.sources[0]).toMatchObject({ id: 'S1', checkedAt: day(-30), stale: true });

    expect(readFileSync(path)).toEqual(bytes);
  }, 60_000);
});

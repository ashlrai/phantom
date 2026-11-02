import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdReflectHarnessDigest } from '../src/cli/reflect-harness-digest.js';
import type { HarnessDigest } from '../src/core/learn/harness-digest-reader.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fictional-harness-format-'));
  path = join(dir, 'fictional-harness-digest.md');
  const guide = readFileSync(new URL('../docs/HARNESS-DIGEST-FORMAT.md', import.meta.url), 'utf8');
  const example = /```markdown\r?\n([\s\S]*?)\r?\n```/.exec(guide);
  if (!example) throw new Error('Fictional digest example is missing');
  writeFileSync(path, example[1]!);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function run(now: string, flags: string[] = []): { code: number; digest: HarnessDigest; err: string } {
  let out = '';
  let err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true; });
  try {
    const code = cmdReflectHarnessDigest(['--file', path, '--json', ...flags], new Date(now));
    return { code, digest: JSON.parse(out) as HarnessDigest, err };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe('fictional harness digest in the contributor guide', () => {
  it('reads the example and accepts the seven-day UTC boundary', () => {
    const result = run('2026-10-31T23:59:59Z', ['--check']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.digest).toEqual({
      v: 1,
      sources: [
        { id: 'S1', title: 'Imaginary replay exercise', checkedAt: '2026-10-31', urls: ['https://example.test/replay'], stale: false, takeaways: ['Record the fictional input before replay.\nCompare the fictional output after replay.'] },
        { id: 'S2', title: 'Imaginary review exercise', checkedAt: '2026-10-24', urls: ['https://example.test/review'], stale: false, takeaways: ['Keep the invented review checklist short.'] },
      ],
      issues: [],
    });
  });

  it('reports a stale source and fails the check on the next UTC day', () => {
    const result = run('2026-11-01T00:00:00Z', ['--check']);
    expect(result.code).toBe(1);
    expect(result.err).toBe('');
    expect(result.digest.sources.map(source => [source.id, source.stale])).toEqual([['S1', false], ['S2', true]]);
    expect(result.digest.issues).toEqual([]);
  });

  it('filters output while checking the unfiltered digest', () => {
    const fresh = run('2026-10-31T12:00:00Z', ['--needs-refresh', '--check']);
    expect(fresh.code).toBe(0);
    expect(fresh.digest).toEqual({ v: 1, sources: [], issues: [] });

    const stale = run('2026-11-01T00:00:00Z', ['--needs-refresh', '--check']);
    expect(stale.code).toBe(1);
    expect(stale.digest.sources.map(source => source.id)).toEqual(['S2']);
    expect(stale.digest.sources[0]?.takeaways).toEqual(['Keep the invented review checklist short.']);
    expect(stale.digest.issues).toEqual([]);
  });
});

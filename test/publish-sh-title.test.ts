import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const helper = fileURLToPath(new URL('../contrib/mac/pr-title.sh', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function lineFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pr-title-line-'));
  roots.push(dir);
  const path = join(dir, 'job.job-line');
  writeFileSync(path, text);
  return path;
}

async function title(job: string, line: string | null, diff?: string): Promise<{ title: string; status: number }> {
  const args = [helper, job, line ?? join(tmpdir(), 'no-such-line-file')];
  if (diff) {
    const dir = mkdtempSync(join(tmpdir(), 'pr-title-diff-'));
    roots.push(dir);
    const path = join(dir, 'job.diff');
    writeFileSync(path, diff);
    args.push(path);
  }
  try {
    const { stdout } = await run('bash', args, { timeout: 15_000 });
    return { title: stdout.trimEnd(), status: 0 };
  } catch (error) {
    return { title: String((error as { stdout?: string }).stdout ?? '').trimEnd(), status: (error as { code?: number }).code ?? 1 };
  }
}

const ROUTER_LINE = 'RQ-REAL-PR-TITLES-1-V2 (P0, pool=devin, tier=mid, repo=phantom, bet=bold, ' +
  'lead=Core, size<=250, family=REAL-PR-TITLES): VISION real-pr-titles. Bridge publish step ' +
  'titles PRs type(scope): summary from the diff via local model, RQ id moved to body.';

describe('publish.sh title helper (contrib/mac/pr-title.sh)', () => {
  it('titles a PR from the router line text', async () => {
    const result = await title('RQ-REAL-PR-TITLES-1-V2', lineFile(`${ROUTER_LINE}\n`));
    expect(result.status).toBe(0);
    expect(result.title).toMatch(/^[a-z]+\(phantom\): /);
    expect(result.title.length).toBeLessThanOrEqual(72);
    expect(result.title).not.toContain('RQ-REAL-PR-TITLES');
  });

  it('caps every router line at 72 chars', async () => {
    const long = `RQ-L (P1, pool=p, repo=phantom): Add ${'very '.repeat(40)}long task that never ends its description.`;
    const result = await title('RQ-L', lineFile(long));
    expect(result.title.length).toBeLessThanOrEqual(72);
    expect(result.title).not.toMatch(/[ .,;:!?-]$/);
  });

  it('falls back to the RQ id when the router line is missing or empty', async () => {
    expect((await title('RQ-MISSING', null)).title).toBe('RQ-MISSING');
    expect((await title('RQ-EMPTY', lineFile(''))).title).toBe('RQ-EMPTY');
    expect((await title('RQ-WS', lineFile('   \n'))).title).toBe('RQ-WS');
  });

  it('prints one printable line even for hostile line text', async () => {
    const hostile = 'RQ-H (P1, repo=phantom): Fix `$(touch /tmp/pwned)` injection; add "quotes" and\ttabs.';
    const result = await title('RQ-H', lineFile(hostile));
    expect(result.status).toBe(0);
    expect(result.title).toMatch(/^[a-z]+\(phantom\): /);
    expect(result.title).not.toContain('\n');
    expect(result.title).not.toContain('\t');
  });

  it('ignores the diff path without PHANTOM_ROOT and still titles from the line', async () => {
    const result = await title('RQ-D', lineFile('RQ-D (P2, repo=phantom): Document the publish title contract.'),
      'diff --git a/x b/x\n+payload\n');
    expect(result.status).toBe(0);
    expect(result.title).toBe('docs(phantom): document the publish title contract');
  });

  it('rejects unsafe job ids at argument validation', async () => {
    const result = await title('../escape', lineFile('x'));
    expect(result.status).toBe(2);
    expect(result.title).toBe('');
  });
});

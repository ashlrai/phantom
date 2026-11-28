import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatWorkState, readJobWorkState, workStateOf } from '../src/core/fleet/job-work-state.js';

const job = 'RQ-PROOF-915';
const url = 'https://github.com/ashlrai/phantom/pull/1';
const at = new Date('2026-11-24T12:00:00Z');
const dependency = 'PR published; head and test verification evidence unavailable';

describe('PR publication proof', () => {
  it('does not infer verification from a URL, exit zero, or free text', () => {
    const result = workStateOf({
      job, publish: { text: `tests passed\nRESULT PR ${url}\n`, mtimeMs: at.getTime() },
      rc: { text: '0', mtimeMs: at.getTime() }, launches: null, readyTsv: null, routerQueue: null,
    });
    expect(result).toMatchObject({ state: 'BLOCKED', detail: `${dependency}: ${url}`, source: `${job}.publish`, as_of: at.toISOString() });
    expect(result.evidence).toContain(`publish record says RESULT PR ${url}`);
  });

  it('reads and formats the publication over old launch and queue records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publication-proof-'));
    try {
      await mkdir(join(root, 'queue', 'run'), { recursive: true });
      const files: Record<string, string> = {
        [`${job}.publish`]: `RESULT PR ${url}\n`,
        [`queue/run/${job}.rc`]: '0\n',
        [`queue/run/${job}.launches`]: 'old launch\n',
        'queue/ready.tsv': `id\tstatus\tpool\trepo\n${job}\tREADY\tclaude\tphantom\n`,
        'queue/router-queue.md': `- READY ${job} old work\n`,
      };
      for (const [name, content] of Object.entries(files)) {
        const path = join(root, name);
        await writeFile(path, content);
        await utimes(path, at, at);
      }
      const result = await readJobWorkState(job, { runsDir: root });
      expect(result).toMatchObject({ state: 'BLOCKED', as_of: at.toISOString(), source: `${job}.publish` });
      expect(result.evidence).toContain(`publish record says RESULT PR ${url}`);
      expect(formatWorkState(result)).toBe(`${job}: BLOCKED - ${dependency}: ${url} (as of ${at.toISOString()}, source ${job}.publish)`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

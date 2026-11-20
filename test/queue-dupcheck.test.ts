import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdQueueDupcheck } from '../src/cli/queue-dupcheck.js';
import {
  DUPCHECK_SCHEMA, commandNouns, dupcheckGoalText, dupcheckJob, panelNouns, referenceCommands, type DupcheckSources,
} from '../src/core/queue/dupcheck.js';

const help = [
  { cmd: 'shipped [--since 7d] [--json]', desc: 'What shipped, in plain words.' },
  { cmd: 'queue dedupe [--file <f>] [--apply] [--json]', desc: 'Find repeated jobs.' },
  { cmd: 'queue', desc: 'List queued jobs.' },
];
const sources = (over: Partial<DupcheckSources> = {}): DupcheckSources => ({
  commands: help.map(e => ({ name: `phm ${e.cmd}`, text: e.desc, ref: 'src/cli/help.ts', type: 'command' as const })),
  panes: ['approvals'],
  fileExists: p => p === 'src/cli/shipped.ts',
  merged: [],
  gaps: [],
  ...over,
});
const task = (goal: string): string => `Task, verbatim:\n\nRQ-TEST1 (P1, pool=claude): ${goal} Acceptance: tests pass.\n`;

describe('queue dupcheck', () => {
  it('says likely_done for a command that is already listed, with the file as evidence', () => {
    const r = dupcheckGoalText(task('Add `phm shipped --since 7d` and src/cli/shipped.ts.'), sources());
    expect(r.schema).toBe(DUPCHECK_SCHEMA);
    expect(r.verdict).toBe('likely_done');
    expect(r.evidence.map(e => e.ref)).toEqual(expect.arrayContaining(['src/cli/help.ts', 'src/cli/shipped.ts']));
    expect(r.summary).toMatch(/^Likely done/);
  });

  it('says partial when the command exists but a named flag or file does not', () => {
    const flag = dupcheckGoalText(task('Give `phm shipped` a --site flag.'), sources());
    expect(flag.verdict).toBe('partial');
    expect(flag.nouns.find(n => n.text === '--site')?.found).toBe(false);
    const file = dupcheckGoalText(task('Run phm shipped from src/core/release/new-feed.ts.'), sources());
    expect(file.verdict).toBe('partial');
    expect(file.summary).toContain('src/core/release/new-feed.ts');
  });

  it('says new when nothing named exists, even if it edits a file that does', () => {
    const r = dupcheckGoalText(task('Deliver: `phm queue dupcheck <job-id> [--json]` in src/cli/shipped.ts.'), sources());
    expect(r.verdict).toBe('new');
    expect(r.nouns.find(n => n.text === 'phm queue dupcheck')?.found).toBe(false);
  });

  it('says unknown, not new, when the goal names no command, file or panel', () => {
    const r = dupcheckGoalText(task('Make the fleet calmer and tidy things up.'), sources());
    expect(r.verdict).toBe('unknown');
    expect(r.nouns).toEqual([]);
    expect(r.summary).toMatch(/^Unknown/);
  });

  it('counts a command merged in the last week and the same job id merged', () => {
    const merged = [{ jobId: 'RQ-OTHER', pr: 7, title: 'feat: queue dupcheck for jobs', mergedAt: '2026-11-19T01:00:00.000Z' }];
    const viaPr = dupcheckGoalText(task('Add `phm queue dupcheck`.'), sources({ merged }));
    expect(viaPr.verdict).toBe('likely_done');
    expect(viaPr.evidence[0]).toMatchObject({ type: 'merged', ref: 'PR #7' });
    const sameId = dupcheckGoalText(task('Make things calmer.'), sources({ merged: [{ ...merged[0]!, jobId: 'RQ-TEST1' }] }), { jobId: 'RQ-TEST1' });
    expect(sameId.verdict).toBe('likely_done');
  });

  it('checks panels and keeps gaps visible', () => {
    const r = dupcheckGoalText(task('Add an Approvals panel and a Costs panel.'), sources({ gaps: ['jobs ledger unreadable'] }));
    expect(r.verdict).toBe('partial');
    expect(r.gaps).toEqual(['jobs ledger unreadable']);
  });

  it('extracts nouns without swallowing plain words', () => {
    expect(commandNouns('Run phm shipped in plain words, then `phm queue dupcheck <id>` and phm queue.')).toEqual(['shipped', 'queue dupcheck']);
    expect(panelNouns('the Approvals panel and a new desktop pane')).toEqual(['approvals']);
    const rows = referenceCommands('| <code>phm queue top&#124;lane&#124;drop &lt;id&gt;</code> | Steer a job. | x |\n| other |');
    expect(rows).toEqual([expect.objectContaining({ name: 'phm queue top|lane|drop <id>', text: 'Steer a job.' })]);
  });

  it('reads a prompt file and the 7-day job records from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dupcheck-'));
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await mkdir(join(dir, 'queue'), { recursive: true });
    const now = Date.parse('2026-11-19T12:00:00Z');
    await writeFile(join(dir, 'metrics/jobs.jsonl'), [
      JSON.stringify({ job_id: 'RQ-OLD', outcome: 'merged', merged_at: '2026-11-01T00:00:00Z', title: 'phm queue dupcheck' }),
      JSON.stringify({ job_id: 'RQ-NEW', outcome: 'merged', merged_at: '2026-11-18T00:00:00Z', pr: 9, title: 'phm queue dupcheck' }),
      'not json merge',
    ].join('\n'));
    const prompt = join(dir, 'p.md');
    await writeFile(prompt, task('Add `phm queue dupcheck`.'));
    const r = await dupcheckJob(prompt, { root: dir, runsDir: dir, now, help });
    expect(r.verdict).toBe('likely_done');
    expect(r.evidence.filter(e => e.type === 'merged').map(e => e.ref)).toEqual(['PR #9']);
    await writeFile(join(dir, 'queue/ready.tsv'), `RQ-TEST1\tphantom\tclaude\twork\t${prompt}\n`);
    expect((await dupcheckJob('RQ-TEST1', { root: dir, runsDir: dir, now, help })).source).toEqual({ kind: 'job', id: 'RQ-TEST1' });
    await expect(dupcheckJob('RQ-MISSING', { root: dir, runsDir: dir, help })).rejects.toThrow('not in the queue');
  });

  it('prints plain words or JSON and rejects bad usage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dupcheck-cli-'));
    const prompt = join(dir, 'p.md');
    await writeFile(prompt, task('Make things calmer.'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdQueueDupcheck([prompt, '--json'])).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ schema: DUPCHECK_SCHEMA, verdict: 'unknown' });
      log.mockClear();
      expect(await cmdQueueDupcheck([prompt])).toBe(0);
      expect(String(log.mock.calls[0]![0]).split('\n')[0]).toBe('unknown');
      expect(await cmdQueueDupcheck([])).toBe(2);
      expect(await cmdQueueDupcheck([join(dir, 'missing.md')])).toBe(1);
    } finally { log.mockRestore(); err.mockRestore(); }
  });
});

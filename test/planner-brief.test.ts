import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlannerBrief, writePlannerBrief, type PlannerBriefGit } from '../src/core/fleet/planner-brief.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'brief-')); roots.push(root);
  await mkdir(join(root, 'leader/drop'), { recursive: true }); await mkdir(join(root, 'queue'));
  return root;
}
const git: PlannerBriefGit = (_program, args, options, done) => {
  expect(args.slice(-4)).toEqual(['log', 'origin/master', '--format=%s', '-15']);
  expect(options).toMatchObject({ timeout: 5000, shell: false });
  done(null, `ordinary\nbridge(test): ${'x'.repeat(120)}\n`);
};
it('assembles ordered live sections with bounded rows, Python booleans, scrubbed notes and private writes', async () => {
  const root = await fixture();
  await Promise.all([
    writeFile(join(root, 'leader/ORCHESTRATION.md'), '# Orchestrate'),
    writeFile(join(root, 'queue/claude-lane.state'), ' ready \n'),
    writeFile(join(root, 'queue/status.json'), JSON.stringify({ lanes: { a: { running: 1, target: 2, queued: 3, held: true }, b: { held: false } } })),
    writeFile(join(root, 'leader/drop/ingested.tsv'), Array.from({ length: 400 }, (_, i) => `time\tid${i}\twho\tlane\ttier\ttitle${i}\n`).join('')),
    writeFile(join(root, 'leader/MASON-INBOX.md'), Array.from({ length: 90 }, (_, i) =>
      `## 2026-01-01 ${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')} ET (Mason, Phantom desktop) PRIORITY P0\ninbox${i}\n`).join('')),
  ]);
  const brief = await buildPlannerBrief({ runsRoot: root, git, note: '\n\t' + 'n'.repeat(600) });
  expect(brief.sections).toEqual({ usedIds: 400, usedTitles: 60, lanes: 2, inboxLines: 180, merges: 1 });
  expect(brief.missing).toEqual([]);
  const markers = ['# Orchestrate', 'NOTE FROM TICK:', '## CLAUDE LANE: ready', '## LANES', '## USED IDS', '## USED TITLES', '## RECENT PHANTOM MERGES', '## MASON INBOX (newest last)'];
  const positions = markers.map(marker => brief.text.indexOf(marker));
  expect(positions.every((pos, i) => pos >= 0 && (i === 0 || pos > positions[i - 1]!))).toBe(true);
  expect(brief.text).toContain('a running 1 target 2 queued 3 held True\nb running 0 target 0 queued 0 held False');
  expect(brief.text).toContain('## USED IDS\nid0 id1');
  expect(brief.text).toContain('## USED TITLES\ntitle340\n');
  expect(brief.text).toContain('## MASON INBOX (newest last)\n## 2026-01-01 00:00 ET (Mason, Phantom desktop) PRIORITY P0\ninbox0\n');
  expect(brief.text.split('\n').find(line => line.startsWith('NOTE'))).toHaveLength(516);
  expect(brief.text.split('\n').at(-1)).toBe('Now write the job files in your current directory, then stop. Output a one-line summary.');
  const result = writePlannerBrief(root, brief.text);
  expect(await readFile(result.path, 'utf8')).toBe(brief.text);
  expect(result.bytes).toBe(brief.bytes);
  expect((await stat(result.path)).mode & 0o777).toBe(0o600);
  expect(() => writePlannerBrief(root, 'x'.repeat(8 * 1024 * 1024 + 1))).toThrow('8 MiB');
});
it('reports absent, oversized, symlink and malformed sources without throwing, and handles git failure', async () => {
  const root = await fixture();
  await writeFile(join(root, 'leader/ORCHESTRATION.md'), 'x'.repeat(256 * 1024 + 1));
  await symlink(join(root, 'leader/ORCHESTRATION.md'), join(root, 'queue/claude-lane.state'));
  await writeFile(join(root, 'queue/status.json'), '{');
  const brief = await buildPlannerBrief({ runsRoot: root, git: () => { throw new Error('failed'); } });
  expect(brief.missing).toHaveLength(6);
  expect(brief.text).toContain('## ORCHESTRATION.md missing');
  expect(brief.text).toContain('## CLAUDE LANE: unknown');
  expect(brief.text).toContain('(unavailable from Phantom; read git log origin/master)');
});
it('scrubs secrets across source text and notes', async () => {
  const root = await fixture();
  await writeFile(join(root, 'leader/ORCHESTRATION.md'), 'password=fixture-secret');
  const brief = await buildPlannerBrief({ runsRoot: root, git, note: 'password=another-fixture' });
  expect(brief.text).not.toContain('fixture-secret');
  expect(brief.text).not.toContain('another-fixture');
});

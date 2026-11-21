import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INGEST_JOB_FILE, INGEST_JOB_HEADER, INGEST_JOB_ID } from '../src/core/fleet/drop-job-writer.js';
import { readGapProposals, recordGapProposal } from '../src/core/fleet/gap-proposal-record.js';
import { readJobGaps } from '../src/core/fleet/job-gaps.js';
import { readSelfSupplyToday, readSupplyDoctor, supplyDoctorLines } from '../src/core/fleet/supply-doctor.js';

const NOW = Date.parse('2026-11-19T15:00:00');
const none = { openIdeas: async () => [], queuedWork: async () => [], mergedTitles: async () => [] };
let runs = '';
beforeEach(async () => { runs = await mkdtemp(join(tmpdir(), 'gap-landing-')); });
afterEach(async () => { await rm(runs, { recursive: true, force: true }); });

async function seedFinishedJob(job: string, notes: string): Promise<void> {
  await mkdir(join(runs, 'metrics'), { recursive: true });
  await writeFile(join(runs, 'metrics', 'jobs.jsonl'), `${JSON.stringify({ event: 'outcome', job, lane: 'claude', empty: true, repo: 'phantom', ts: new Date(NOW - 3_600_000).toISOString() })}\n`);
  await mkdir(join(runs, 'wt', job), { recursive: true });
  await writeFile(join(runs, 'wt', job, 'BRIDGE_NOTES.md'), notes);
}
const propose = () => readJobGaps(24, { runsDir: runs, wtDir: join(runs, 'wt'), now: NOW, propose: true, ...none });
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

describe('gap drop file, proposer to ready row', () => {
  it('writes a file the host ingest patterns accept, then counts it at each step', async () => {
    await seedFinishedJob('RQ-SRC', '## Remaining gaps\n- Show the queue depth in the status line\n');
    const report = await propose();
    const row = report.proposed![0]!;
    expect(row.queued).toBe(true);

    // Drop dir, file name, header and id shape are exactly what the ingest expects.
    const dropDir = join(runs, 'leader', 'drop', 'claude');
    const [name] = await readdir(dropDir);
    expect(name).toMatch(INGEST_JOB_FILE);
    expect(`RQ-PHX-${row.jobId}`).toMatch(INGEST_JOB_ID);
    const text = await readFile(join(dropDir, name!), 'utf8');
    expect(text.split('\n')[0]).toMatch(INGEST_JOB_HEADER);
    expect(text.split('\n')[0]).toBe('#job repo=phantom lane=claude tier=work');

    // Proposed 1; nothing ingested or launched yet (ingested.tsv is missing, so those read unknown).
    expect((await readSelfSupplyToday(runs, NOW)).line).toBe('Self-supply today: 1 proposed, unknown ingested, unknown launched');

    // The host ingest moves the file into queue/prompts and logs a row.
    await mkdir(join(runs, 'queue', 'prompts'), { recursive: true });
    await rename(join(dropDir, name!), join(runs, 'queue', 'prompts', name!));
    const at = '2026-11-19 14:00:00';
    await writeFile(join(runs, 'leader', 'drop', 'ingested.tsv'), `${at}\t${name!.replace('.md', '')}\tclaude\tclaude\twork\tGoal: Show the queue depth in the status line\n`);
    expect((await readSelfSupplyToday(runs, NOW)).line).toBe('Self-supply today: 1 proposed, 1 ingested, 0 launched');

    // The launcher leaves RQ-PHX-<id>.prompt in the runs dir.
    await writeFile(join(runs, `RQ-PHX-${row.jobId}.prompt`), 'x');
    const today = await readSelfSupplyToday(runs, NOW);
    expect(today).toMatchObject({ proposed: 1, ingested: 1, launched: 1 });

    const doctor = await readSupplyDoctor({ runsDir: runs, now: () => NOW, readOff: async () => false, readCandidates: async () => null });
    expect(doctor.selfSupplyToday).toEqual(today);
    expect(supplyDoctorLines(doctor)[1]).toBe('Self-supply today: 1 proposed, 1 ingested, 1 launched.');
  });

  it('does not propose a gap again within 24 h, and does after the window', async () => {
    await seedFinishedJob('RQ-SRC', '## Remaining gaps\n- Show the queue depth in the status line\n');
    expect((await propose()).proposed).toHaveLength(1);
    const again = await propose();
    expect(again.proposed).toEqual([]);
    expect(again.dropped).toMatchObject([{ reason: 'proposed-24h' }]);
    // Same gap, record older than a day: it is proposable again (the file is gone, as after ingest).
    await rm(join(runs, 'leader'), { recursive: true });
    await writeFile(join(runs, 'metrics', 'gap-proposed.jsonl'), `${JSON.stringify({ at: iso(25), id: 'GAPOLD', title: 'Show the queue depth in the status line', repo: 'phantom' })}\n`);
    expect((await propose()).proposed).toMatchObject([{ queued: true }]);
  });

  it('reads missing or unreadable files as unknown, and an empty record as zero', async () => {
    expect((await readSelfSupplyToday(runs, NOW)).line).toBe('Self-supply today: unknown proposed, unknown ingested, unknown launched');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await mkdir(join(runs, 'leader', 'drop'), { recursive: true });
    await writeFile(join(runs, 'metrics', 'gap-proposed.jsonl'), 'not json\n');
    await writeFile(join(runs, 'leader', 'drop', 'ingested.tsv'), '2026-11-19 14:00:00\tRQ-PHX-OTHER\tclaude\tclaude\twork\tGoal: other\n');
    expect(await readSelfSupplyToday(runs, NOW)).toMatchObject({ proposed: 0, ingested: 0, launched: 0 });
    expect(await readGapProposals(join(runs, 'nope'), NOW)).toMatchObject({ state: 'unknown', why: 'missing' });
  });

  it('keeps only the last 24 h of the record and skips malformed lines', async () => {
    await recordGapProposal(runs, { at: iso(30), id: 'GAPAAA', title: 'Old gap here', repo: 'phantom' });
    await recordGapProposal(runs, { at: iso(2), id: 'GAPBBB', title: 'Fresh gap here', repo: 'phantom' });
    const read = await readGapProposals(runs, NOW);
    expect(read.state === 'known' && read.proposals.map(p => p.id)).toEqual(['GAPBBB']);
  });
});

import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseLeaderNotes, readLeaderJournal } from '../src/core/fleet/leader-journal.js';

const fixture = `## Job file
- Ignore this job.
## Leader notes, 01:00 ET Oct 31
-  Fake supply forecast.  
- Fake blocker.
## Rules
- Ignore this rule.
## Leader notes, 08:50 ET Oct 31 (newer than the notes above where they differ)
- Fake run-out estimate.
- Stop writing fake duplicates.
`;

it('selects only notes, newest first, with trimmed bullets and verbatim time labels', () => {
  expect(parseLeaderNotes(fixture)).toEqual([
    { at: '08:50 ET Oct 31', bullets: ['Fake run-out estimate.', 'Stop writing fake duplicates.'] },
    { at: '01:00 ET Oct 31', bullets: ['Fake supply forecast.', 'Fake blocker.'] },
  ]);
  expect(parseLeaderNotes(fixture, 1)).toHaveLength(1);
  expect(parseLeaderNotes(fixture, 0)).toEqual([]);
  expect(parseLeaderNotes(`## Leader notes, fake time\n- ${'x'.repeat(500)}`)[0].bullets[0]).toHaveLength(400);
  expect(parseLeaderNotes('## Leader notes, fake time\n- secret=fake-value')[0].bullets).toEqual(['[redacted line]']);
});

it('reads the bounded orchestration source and handles missing and unsafe sources', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'journal-notes-'));
  try {
    await mkdir(join(runsDir, 'leader'));
    const path = join(runsDir, 'leader', 'ORCHESTRATION.md');
    const missing = await readLeaderJournal({ runsDir });
    expect(missing.sources.orchestration).toBe('missing');
    expect(missing.notes).toEqual([]);
    await writeFile(path, fixture);
    const present = await readLeaderJournal({ runsDir });
    expect(present.sources.orchestration).toBe('healthy');
    expect(present.notes).toEqual(parseLeaderNotes(fixture));
    await writeFile(path, `${'x'.repeat(256 * 1024)}\n${fixture}`);
    expect((await readLeaderJournal({ runsDir })).notes).toEqual(parseLeaderNotes(fixture));
    await rm(path);
    await symlink(join(runsDir, 'other.md'), path);
    await writeFile(join(runsDir, 'other.md'), fixture);
    const unsafe = await readLeaderJournal({ runsDir });
    expect(unsafe.sources.orchestration).toBe('degraded');
    expect(unsafe.notes).toEqual([]);
  } finally { await rm(runsDir, { recursive: true, force: true }); }
});

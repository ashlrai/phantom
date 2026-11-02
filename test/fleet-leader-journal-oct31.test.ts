// Keep the colocated notes regressions in the standard backend test lane.
import '../src/core/fleet/leader-journal.notes.test.js';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseIngestedTsv, parseIngestLog, parsePlanLog, readLeaderJournal } from '../src/core/fleet/leader-journal.js';

const fixtures = join(process.cwd(), 'test/fixtures/leader-journal');
const tempDirs: string[] = [];
async function temp(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'leader-journal-')); tempDirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('leader journal parsers', () => {
  it('parses newest passes, flattens nested bullets, and scrubs whole sensitive lines and home paths', async () => {
    const passes = parsePlanLog(await readFile(join(fixtures, 'PLAN-LOG.md'), 'utf8'));
    expect(passes.map(pass => pass.at)).toEqual(['2026-10-29 ~15:05 ET', '2026-10-29 ~14:05 ET', '2026-10-29 ~13:05 ET']);
    expect(passes[0].sections[0].bullets).toEqual(['[redacted line]', 'Checked the queue']);
    expect(passes[1].sections[0].bullets).toEqual(['Work from ~/projects/phantom', 'Nested work']);
  });
  it('bounds passes, sections, titles, bullets and caller limits', () => {
    const title = 'x'.repeat(100);
    const pass = `## time\n**${title}**\n${Array.from({ length: 15 }, () => `- ${'y'.repeat(350)}`).join('\n')}\n`;
    const result = parsePlanLog(pass.repeat(12));
    expect(result).toHaveLength(8);
    expect(result[0].sections[0].title).toHaveLength(80);
    expect(result[0].sections[0].bullets).toHaveLength(12);
    expect(result[0].sections[0].bullets[0]).toHaveLength(300);
    expect(parsePlanLog(pass, 0)).toEqual([]);
    expect(parsePlanLog(`## pass\n${'**section**\n'.repeat(40)}`)[0].sections).toHaveLength(32);
  });
  it('parses newest ingest entries and skips short TSV rows', async () => {
    const ingest = parseIngestLog(await readFile(join(fixtures, 'ingest.log'), 'utf8'));
    expect(ingest).toEqual([
      { verb: 'accept', file: 'RQ-PHX-BETA.md', reason: null },
      { verb: 'reject', file: 'RQ-PHX-FOO.md', reason: 'denied-path' },
      { verb: 'accept', file: 'RQ-PHX-ALPHA.md', reason: null },
    ]);
    const rows = parseIngestedTsv(await readFile(join(fixtures, 'ingested.tsv'), 'utf8'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ at: '2026-10-29T15:00:00Z', id: 'RQ-PHX-BETA', leader: 'leader-b', lane: 'work', tier: 'frontier', title: 'Second job' });
    expect(parseIngestLog('accept a\n'.repeat(40))).toHaveLength(30);
    expect(parseIngestedTsv('t\ti\tl\tlane\ttier\ttitle\n'.repeat(40))).toHaveLength(30);
    expect(JSON.stringify(parseIngestLog('reject file Authorization: Bearer fake-value-123'))).not.toContain('fake-value-123');
    expect(JSON.stringify(parseIngestedTsv('t\ti\tl\tlane\ttier\tsecret fake'))).not.toContain('secret fake');
  });
});

describe('leader journal reader', () => {
  it('reports missing sources independently', async () => {
    const result = await readLeaderJournal({ runsDir: await temp(), now: () => 0 });
    expect(result).toMatchObject({ generatedAt: '1970-01-01T00:00:00.000Z', sources: { orchestration: 'missing', planLog: 'missing', ingestLog: 'missing', ingested: 'missing' }, passes: [], ingest: [], ingested: [], rejectedLastHour: null });
  });
  it('reads fixtures, counts timestamped rejects and ignores future and old entries', async () => {
    const dir = await temp(); const drop = join(dir, 'leader/drop');
    await mkdir(drop, { recursive: true });
    await writeFile(join(dir, 'leader/PLAN-LOG.md'), await readFile(join(fixtures, 'PLAN-LOG.md')));
    await writeFile(join(drop, 'ingested.tsv'), await readFile(join(fixtures, 'ingested.tsv')));
    await writeFile(join(drop, 'ingest.log'), '2026-10-31T11:30:00Z reject a denied\n2026-10-31T10:00:00Z reject b old\n2026-10-31T12:01:00Z reject c future\n2026-10-31T11:40:00Z accept d\n');
    const result = await readLeaderJournal({ runsDir: dir, now: () => Date.parse('2026-10-31T12:00:00Z') });
    expect(result.sources).toEqual({ orchestration: 'missing', planLog: 'healthy', ingestLog: 'healthy', ingested: 'healthy' });
    expect(result.rejectedLastHour).toBe(1);
    expect(result.ingest[3]).toEqual({ verb: 'reject', file: 'a', reason: 'denied' });
  });
  it('does not claim a complete hourly count when the ingest tail is truncated', async () => {
    const dir = await temp(); const drop = join(dir, 'leader/drop');
    await mkdir(drop, { recursive: true });
    await writeFile(join(drop, 'ingest.log'), `${'x'.repeat(256 * 1024)}\n2026-10-31T11:30:00Z reject a denied\n`);
    const result = await readLeaderJournal({ runsDir: dir, now: () => Date.parse('2026-10-31T12:00:00Z') });
    expect(result.sources.ingestLog).toBe('healthy');
    expect(result.rejectedLastHour).toBeNull();
    expect(result.ingest).toEqual([{ verb: 'reject', file: 'a', reason: 'denied' }]);
  });
  it('refuses symlink files and directories while preserving other sources', async () => {
    const dir = await temp(); const leader = join(dir, 'leader');
    await mkdir(leader);
    await symlink(join(fixtures, 'PLAN-LOG.md'), join(leader, 'PLAN-LOG.md'));
    await symlink(fixtures, join(leader, 'drop'));
    const result = await readLeaderJournal({ runsDir: dir });
    expect(result.sources).toEqual({ orchestration: 'missing', planLog: 'degraded', ingestLog: 'degraded', ingested: 'degraded' });
    expect(result.passes).toEqual([]);
  });
  it('reads only the bounded tail and discards its partial first line', async () => {
    const dir = await temp(); const leader = join(dir, 'leader');
    await mkdir(leader);
    await writeFile(join(leader, 'PLAN-LOG.md'), `## old\n**old**\n- ${'a'.repeat(256 * 1024)}\n## new\n**new**\n- visible\n`);
    const result = await readLeaderJournal({ runsDir: dir });
    expect(result.passes).toEqual([{ at: 'new', sections: [{ title: 'new', bullets: ['visible'] }] }]);
  });
});

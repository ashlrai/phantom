import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLEET_RUNS_INBOX_MAX_CHARS } from '../verse/fleet-runs-types.js';
import { parseOutbox, readOutboxEntries } from './mason-outbox.js';

let runsDir: string;
const outboxPath = (): string => join(runsDir, 'leader', 'MASON-OUTBOX.md');
const write = async (markdown: string): Promise<void> => {
  await mkdir(join(runsDir, 'leader'), { recursive: true });
  await writeFile(outboxPath(), markdown, 'utf8');
};

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'mason-outbox-'));
});
afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

describe('parseOutbox', () => {
  it('reads an ISO 8601 heading time and keeps the heading words after the body', () => {
    const entries = parseOutbox('## 2026-11-04T09:15:00Z Done — judge queue\nRaised grok-a to 3 lanes.\n');
    expect(entries).toEqual([{ at: '2026-11-04T09:15:00Z', text: 'Raised grok-a to 3 lanes.\nDone — judge queue' }]);
  });

  it('reads the MASON-INBOX wall-clock heading shape', () => {
    const entries = parseOutbox('## 2026-11-04 10:22 ET (Leader, Phantom desktop)\nShipped the fix.\nsecond line\n');
    expect(entries).toEqual([{ at: '2026-11-04 10:22', text: 'Shipped the fix.\nsecond line\nET (Leader, Phantom desktop)' }]);
  });

  it('ignores a leading title and preamble, and keeps entries in file order', () => {
    const entries = parseOutbox([
      '# Leader outbox', '', 'loose preamble is not an entry',
      '## 2026-11-04 09:00', 'first', '## notes only heading', 'second', '## undated', 'third',
    ].join('\n'));
    expect(entries.map(entry => entry.at)).toEqual(['2026-11-04 09:00', '', '']);
    expect(entries.map(entry => entry.text)).toEqual(['first', 'second\nnotes only heading', 'third\nundated']);
  });

  it('returns one undated entry for a file with no "## " headings', () => {
    expect(parseOutbox('  \nFree-form answer.\nOver two lines.\n')).toEqual([
      { at: '', text: 'Free-form answer.\nOver two lines.' },
    ]);
    expect(parseOutbox('# just a title\nand prose')).toEqual([{ at: '', text: '# just a title\nand prose' }]);
    expect(parseOutbox('  \n \n')).toEqual([]);
  });

  it('keeps the newest limit entries in file order', () => {
    const markdown = Array.from({ length: 35 }, (_, i) => `## 2026-11-04 10:${String(i).padStart(2, '0')}\nentry ${i}`).join('\n');
    const entries = parseOutbox(markdown);
    expect(entries).toHaveLength(30);
    expect(entries[0]!.text).toBe('entry 5');
    expect(entries[29]!.text).toBe('entry 34');
    expect(parseOutbox(markdown, 2).map(entry => entry.text)).toEqual(['entry 33', 'entry 34']);
    expect(parseOutbox(markdown, 0)).toEqual([]);
  });

  it('caps each entry at FLEET_RUNS_INBOX_MAX_CHARS', () => {
    const entries = parseOutbox(`## 2026-11-04 09:00\n${'x'.repeat(FLEET_RUNS_INBOX_MAX_CHARS + 100)}`);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toHaveLength(FLEET_RUNS_INBOX_MAX_CHARS);
  });

  it('scrubs secret-shaped tokens from the text', () => {
    const token = 'sk-FAKEFAKEFAKEFAKEFAKEFAKE1234';
    const entries = parseOutbox(`## 2026-11-04 09:00\nrotated ${token} into the vault`);
    expect(entries[0]!.text).not.toContain(token);
    expect(entries[0]!.text).toContain('[REDACTED]');
  });
});

describe('readOutboxEntries', () => {
  it('reports a missing file without throwing', async () => {
    await expect(readOutboxEntries({ runsDir })).resolves.toEqual({ sourceState: 'missing', entries: [] });
  });

  it('reads a written file as healthy', async () => {
    await write('# Answers\n\n## 2026-11-04 09:00\nfirst\n\n## 2026-11-04T10:00:00Z\nsecond\n');
    await expect(readOutboxEntries({ runsDir })).resolves.toEqual({ sourceState: 'healthy', entries: [
      { at: '2026-11-04 09:00', text: 'first' },
      { at: '2026-11-04T10:00:00Z', text: 'second' },
    ] });
  });

  it('honours the limit from the newest entries', async () => {
    await write(Array.from({ length: 5 }, (_, i) => `## 2026-11-04 09:0${i}\nentry ${i}`).join('\n'));
    expect((await readOutboxEntries({ runsDir, limit: 2 })).entries.map(entry => entry.text)).toEqual(['entry 3', 'entry 4']);
  });

  it('reports a read error as degraded', async () => {
    // A regular file in place of the runs directory yields ENOTDIR on read.
    const bad = join(runsDir, 'not-a-dir');
    await writeFile(bad, 'fake corrupt source', 'utf8');
    await expect(readOutboxEntries({ runsDir: bad })).resolves.toEqual({ sourceState: 'degraded', entries: [] });
  });

  it('never writes to the file', async () => {
    await write('## 2026-11-04 09:00\nfirst\n');
    await readOutboxEntries({ runsDir });
    await expect(readFile(outboxPath(), 'utf8')).resolves.toBe('## 2026-11-04 09:00\nfirst\n');
  });
});

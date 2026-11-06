import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { cmdFleetVisionLint, lintFleetVision } from '../src/cli/fleet-vision-lint.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
const bet = (text = 'Add NEW src/example.ts', lane = 'claude-api', id = 'VISION') => `BET phantom ${lane} work ${id} P1 ${text}`;
it('accepts every supported lane and ignores non-BET lines', () => {
  for (const lane of ['codex-personal', 'devin', 'claude-api', 'codex-local']) {
    expect(lintFleetVision(`notes\r\n${bet(undefined, lane)}\r\nBETTER ignored`).problems).toEqual([]);
  }
});
it('reports each independent problem with its original line number', () => {
  const result = lintFleetVision(`notes\n${bet('bad '.repeat(151), 'codex', 'VISIONQ8')}`, 'bad');
  expect(result.problems).toHaveLength(5);
  expect(result.problems.every(p => p.line === 2)).toBe(true);
});
it('requires six header fields and nonempty text', () => {
  for (const line of ['BET', 'BET phantom claude-api work ID', 'BET phantom claude-api work ID P1']) {
    expect(lintFleetVision(line).problems[0]?.message).toContain('six fields');
  }
});
it('counts Unicode characters at the 600 character boundary', () => {
  const prefix = 'NEW src/a.ts ';
  const text = prefix + '😀'.repeat(600 - prefix.length);
  expect(lintFleetVision(bet(text)).problems).toEqual([]);
  expect(lintFleetVision(bet(text + 'x')).problems).toHaveLength(1);
});
it('requires a NEW file name and supports quoted paths and root files', () => {
  for (const text of ['NEW `src/a.ts`', 'NEW README.md']) expect(lintFleetVision(bet(text)).problems).toEqual([]);
  for (const text of ['Edit src/a.ts', 'NEW feature', 'NEW src/']) expect(lintFleetVision(bet(text)).problems).toHaveLength(1);
});
it('matches deny words literally, case-insensitively, without substrings', () => {
  expect(lintFleetVision(bet('NEW a.ts scaffold SCAM'), 'scam\nscam').problems).toHaveLength(1);
  expect(lintFleetVision(bet('NEW a.ts scaffold'), 'fold .*').problems).toEqual([]);
});
it('registers the verb and emits a typed JSON report', async () => {
  expect((await FLEET_SUBCOMMAND_LOADERS['vision-lint']!()).cmdFleetVisionLint).toBe(cmdFleetVisionLint);
  vi.mocked(readFile).mockResolvedValue(bet());
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  expect(await cmdFleetVisionLint(['input', '--json'])).toBe(0);
  expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual({ readOnly: true, problems: [] });
});
it('prints one plain line per problem and reads the explicit deny file', async () => {
  vi.mocked(readFile).mockResolvedValueOnce(bet('NEW a.ts forbidden')).mockResolvedValueOnce('forbidden');
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  expect(await cmdFleetVisionLint(['input', '--deny-file', 'deny'])).toBe(1);
  expect(out.mock.calls[0]![0]).toBe('line 1: Task text contains denied word: forbidden\n');
});
it('rejects bad arguments and unreadable files without echoing file contents', async () => {
  vi.mocked(readFile).mockRejectedValue(new Error('private content'));
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  for (const args of [[], ['input', '--deny-file'], ['input', '--unknown'], ['input', 'extra'], ['missing', '--json']]) {
    expect(await cmdFleetVisionLint(args)).toBe(2);
  }
  expect(out.mock.calls.flat().join('')).not.toContain('private content');
});

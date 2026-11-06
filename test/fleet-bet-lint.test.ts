import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBetLint, lintFleetBets } from '../src/cli/fleet-bet-lint.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
const bet = (short = 'OK', lane = 'devin', text = 'Do work') => `BET phantom ${lane} work ${short} ${text}`;
afterEach(() => vi.restoreAllMocks());
it('accepts every allowed lane and only considers lines starting BET space', () => {
  for (const lane of ['codex-personal', 'devin', 'claude-api', 'codex-local']) {
    expect(lintFleetBets(`notes\nBET\n BET ignored\nBETTER ignored\n${bet('AB12', lane)}`, '').problems).toEqual([]);
  }
});
it('counts all text after field five with Unicode and the 600 character boundary', () => {
  expect(lintFleetBets(bet('OK', 'devin', '😀'.repeat(600)), '').problems).toEqual([]);
  expect(lintFleetBets(bet('OK', 'devin', '😀'.repeat(601)), '').problems[0]?.message).toContain('600');
  expect(lintFleetBets(bet('OK', 'devin', 'P1 ' + 'x'.repeat(598)), '').problems).toHaveLength(1);
});
it('checks SHORT boundaries and alphabet', () => {
  for (const short of ['AB', '12', 'A'.repeat(24)]) expect(lintFleetBets(bet(short), '').problems).toEqual([]);
  for (const short of ['A', 'A'.repeat(25), 'lower', 'A-B', 'A_B']) {
    expect(lintFleetBets(bet(short), '').problems[0]?.message).toContain('SHORT');
  }
});
it('reports independent problems and original line numbers, including malformed headers', () => {
  const report = lintFleetBets(`notes\r\n${bet()}\r\n${bet('OK', 'codex', 'x'.repeat(601))}\r\nBET phantom`, 'RQ-OKQ8');
  expect(report.problems.filter(p => p.line === 3)).toHaveLength(4);
  expect(report.problems.filter(p => p.line === 4)).toHaveLength(2);
});
it('uses only the last 400 queue lines and matches complete IDs', () => {
  const tail = Array(399).fill('other').join('\n');
  expect(lintFleetBets(bet(), `RQ-OKQ8\n${tail}\n`).problems).toHaveLength(1);
  expect(lintFleetBets(bet(), `RQ-OKQ8\nother\n${tail}\n`).problems).toEqual([]);
  expect(lintFleetBets(bet(), 'RQ-OKQ80 RQ-OKQ8MORE X-RQ-OKQ8').problems).toEqual([]);
  expect(lintFleetBets(bet(), '| RQ-OKQ8 |').problems).toHaveLength(1);
});
it('registers the command and supports injected readers with JSON and plain output', async () => {
  expect((await FLEET_SUBCOMMAND_LOADERS['bet-lint']!()).cmdFleetBetLint).toBe(cmdFleetBetLint);
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const readers = { readVision: vi.fn(async () => bet()), readQueue: vi.fn(async () => '') };
  expect(await cmdFleetBetLint(['--json'], readers)).toBe(0);
  expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual({ readOnly: true, problems: [] });
  readers.readQueue.mockResolvedValue('RQ-OKQ8');
  expect(await cmdFleetBetLint([], readers)).toBe(1);
  expect(String(out.mock.calls.at(-1)![0])).toContain('line 1:');
});
it('fails safely on either unreadable input without exposing error contents', async () => {
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  for (const failing of ['readVision', 'readQueue'] as const) {
    const readers = { readVision: async () => '', readQueue: async () => '' };
    readers[failing] = async () => { throw new Error('private contents'); };
    expect(await cmdFleetBetLint(['--json'], readers)).toBe(1);
    expect(JSON.parse(String(out.mock.calls.at(-1)![0])).error).toContain('Unable to read');
  }
  expect(out.mock.calls.flat().join('')).not.toContain('private contents');
});
it('handles help and rejects unknown, positional and duplicate arguments before reading', async () => {
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const readers = { readVision: vi.fn(), readQueue: vi.fn() };
  expect(await cmdFleetBetLint(['--help'], readers)).toBe(0);
  for (const args of [['--bad'], ['file'], ['--json', '--json']]) expect(await cmdFleetBetLint(args, readers)).toBe(2);
  expect(readers.readVision).not.toHaveBeenCalled();
});

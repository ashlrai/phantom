import { describe, it, expect, vi } from 'vitest';
import { readSignals, type SignalIO } from '../src/core/signals.js';
import { cmdSignals } from '../src/cli/signals.js';
const sha = 'a'.repeat(40);
function fixture(): SignalIO {
  return {
    async run(command, args) {
      if (command === 'git' && args[0] === 'remote') return 'git@github.com:ashlrai/phantom.git\n';
      if (command === 'gh' && args[0] === 'api') return '{"stargazers_count":0,"forks_count":3}';
      if (command === 'gh') return JSON.stringify([{ number: 2, mergeCommit: { oid: sha }, files: [{ path: 'src/a.ts' }] }]);
      if (command === 'git') return args[0] === 'log' ? 'src/a.ts\n' : '';
      return '{"package":"@ashlr/phantom","downloads":12,"start":"2026-10-25","end":"2026-10-31"}';
    },
    async read(path) {
      if (path.endsWith('package.json')) return '{"name":"@ashlr/phantom"}';
      if (path.endsWith('.tsv')) return 'repo\tusers\nother/repo\t9\nashlrai/phantom\t1\n';
      if (path.endsWith('revenue-signals.json')) return '{"repo":"ashlrai/phantom","revenue":false}';
      return '{"repo":"ashlrai/phantom","installs":4}';
    },
  };
}
describe('repository signals', () => {
  it('reports real zeros, scoped rows, static revenue and deterministic usage evidence', async () => {
    const result = await readSignals('/tmp/repo', fixture());
    expect(result).toEqual(await readSignals('/tmp/repo', fixture()));
    expect(result).toMatchObject({ repo: 'ashlrai/phantom', stars: 0, forks: 3, revenue: false, mcpInstalls: 4,
      npmWeeklyDownloads: { downloads: 12 }, adoptionScoreboard: { rows: [['ashlrai/phantom', '1']] },
      used: { value: [{ pr: 2, evidence: 'later touched', files: ['src/a.ts'] }] } });
  });
  it('reports missing sources without guessing zeros', async () => {
    const fail = async () => { throw new Error('unavailable'); };
    const result = await readSignals('/tmp/repo', { run: fail, read: fail });
    expect(result).toMatchObject({ repo: 'no source', stars: 'no source', forks: 'no source',
      used: { value: 'no source' }, revenue: 'no source', mcpInstalls: 'no source', npmWeeklyDownloads: 'no source' });
  });
  it('rejects invalid counts, wrong repo static records and malformed scoreboard', async () => {
    const source = fixture();
    source.read = async () => '{"repo":"other/repo","installs":9,"revenue":true}';
    const original = source.run;
    source.run = async (cmd, args, cwd) => cmd === 'gh' && args[0] === 'api'
      ? '{"stargazers_count":-1,"forks_count":"3"}' : original(cmd, args, cwd);
    expect(await readSignals('/tmp/repo', source)).toMatchObject({ stars: 'no source', forks: 'no source',
      mcpInstalls: 'no source', revenue: 'no source', adoptionScoreboard: 'no source' });
  });
  it('does not label untouched merged PRs used', async () => {
    const source = fixture(), original = source.run;
    source.run = async (cmd, args, cwd) => cmd === 'git' && args[0] === 'log' ? '' : original(cmd, args, cwd);
    expect((await readSignals('/tmp/repo', source)).used.value).toEqual([]);
  });
  it('withholds usage when local merge ancestry cannot be verified', async () => {
    const source = fixture(), original = source.run;
    source.run = async (cmd, args, cwd) => {
      if (cmd === 'git' && args[0] === 'merge-base') throw new Error('shallow history');
      return original(cmd, args, cwd);
    };
    expect((await readSignals('/tmp/repo', source)).used.value).toBe('no source');
  });
  it('degrades null metadata and package manifests independently', async () => {
    const source = fixture();
    const original = source.run;
    source.run = async (cmd, args, cwd) => args[0] === 'remote' ? original(cmd, args, cwd) : 'null';
    source.read = async () => 'null';
    expect(await readSignals('/tmp/repo', source)).toMatchObject({ stars: 'no source', npmWeeklyDownloads: 'no source' });
  });
  it('rejects unsupported CLI flags', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { expect(await cmdSignals(['--repo'])).toBe(2); } finally { spy.mockRestore(); }
  });
});

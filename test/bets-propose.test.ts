import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdBets } from '../src/cli/bets.js';
import { helpItems, type BetsCheckSources } from '../src/core/fleet/bets-check.js';
import {
  BETS_PROPOSE_SCHEMA, gatherCandidates, isBetsProposeReport, proposeBets, proposeLines, readRepoName, suggestId, type ProposeCandidate,
} from '../src/core/fleet/bets-propose.js';

const sources = (): BetsCheckSources => ({
  cli: helpItems([
    { cmd: 'tools [--json] [--lane <lane>]', desc: 'Which lane has which tool, a parity score per lane and the top 3 gaps with a fix.' },
    { cmd: 'doctor [--json]', desc: 'Check the install.' },
  ]),
  api: [], pane: [],
  doc: [{ kind: 'doc', name: 'Lane tool parity', path: 'docs/TOOLS.md', text: 'TOOLS' }],
});

// 3 new, 1 partial, 1 existing.
const backlog: ProposeCandidate[] = [
  { source: 'todo', title: 'quantum harmonizer for llama choirs', area: 'core/fleet', path: 'src/core/fleet/x.ts', line: 7 },
  { source: 'roadmap', title: 'doctor for zebra llama choirs', area: 'docs', path: 'docs/ROADMAP-NEXT.md', line: 3 },
  { source: 'test', title: 'plasma kettle scheduler', area: 'test/k.test.ts', path: 'test/k.test.ts', line: 12 },
  { source: 'cli', title: 'phm cobalt', area: 'cobalt', path: 'docs/CLI-REFERENCE.md' },
  { source: 'todo', title: 'lane-by-tool capability matrix', area: 'core/fleet', path: 'src/core/fleet/y.ts', line: 9 },
];

describe('bets propose', () => {
  it('drops the existing candidate, keeps new and partial, and ranks user-facing then smallest', () => {
    const r = proposeBets(backlog, sources(), { lane: 'claude', repo: 'phantom', count: 10 });
    expect(r).toMatchObject({ schema: BETS_PROPOSE_SCHEMA, readOnly: true, lane: 'claude', gathered: 5, droppedExisting: 1 });
    expect(r.proposals.map(p => [p.source, p.verdict])).toEqual([['cli', 'new'], ['roadmap', 'partial'], ['test', 'new'], ['todo', 'new']]);
    expect(r.proposals.map(p => p.rank)).toEqual([1, 2, 3, 4]);
    expect(r.proposals.some(p => p.goal.includes('capability matrix'))).toBe(false);
    expect(isBetsProposeReport(JSON.parse(JSON.stringify(r)))).toBe(true);
  });

  it('gives every row one-token id, repo, size, a goal and an Acceptance line', () => {
    const r = proposeBets(backlog, sources(), { lane: 'claude', repo: 'phantom', count: 10 });
    for (const p of r.proposals) {
      expect(p.id).toMatch(/^RQ-[A-Z0-9]+$/);
      expect(p.repo).toBe('phantom');
      expect(p.size).toBeGreaterThan(0);
      expect(p.goal.length).toBeGreaterThan(30);
      expect(p.acceptance).toMatch(/^Acceptance: /);
    }
    expect(new Set(r.proposals.map(p => p.id)).size).toBe(4);
    expect(r.proposals[1]!.suggestedDelta).toContain('build only that');
  });

  it('honors count and says so in plain words when nothing is left', () => {
    const one = proposeBets(backlog, sources(), { lane: 'zai', repo: 'phantom', count: 1 });
    expect(one.proposals).toHaveLength(1);
    expect(proposeLines(one).join('\n')).toContain('Read-only: nothing was queued.');
    const none = proposeBets([backlog[4]!], sources(), { lane: 'zai', repo: 'phantom', count: 3 });
    expect(proposeLines(none)).toEqual(['Nothing new to propose for zai: 1 candidates found, 1 already exist.']);
  });

  it('suggests stable single-token ids', () => {
    expect(suggestId('plasma kettle scheduler')).toBe(suggestId('plasma kettle scheduler'));
    expect(suggestId('!!')).toMatch(/^RQ-WORK\d\d$/);
  });
});

describe('bets propose readers and CLI', () => {
  const roots: string[] = [];
  const checkout = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'bets-propose-'));
    roots.push(root);
    mkdirSync(join(root, 'src/core/fleet'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"@ashlr/demo"}');
    writeFileSync(join(root, 'src/core/fleet/a.ts'), "// TODO(mason): retry the plasma kettle on timeout\nconst s = '// TODO: inside a string is ignored';\nconst ok = 1;\n");
    writeFileSync(join(root, 'test/a.test.ts'), "it.skip('plasma kettle retry', () => {});\nit.skipIf(true)('platform guard stays out', () => {});\n");
    writeFileSync(join(root, 'docs/ROADMAP-NEXT.md'), '- [ ] cobalt lane ledger export\n- [x] shipped thing already done\n');
    writeFileSync(join(root, 'docs/guide.md'), 'Run `phm doctor` to check.\n');
    return root;
  };
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  it('gathers from all four sources and ignores strings, ticked items and platform guards', () => {
    const root = checkout();
    const c = gatherCandidates(root, [{ cmd: 'doctor [--json]' }, { cmd: 'cobalt [--json]' }]);
    expect(c.map(x => x.source).sort()).toEqual(['cli', 'roadmap', 'test', 'todo']);
    expect(c.find(x => x.source === 'todo')).toMatchObject({ area: 'mason', line: 1, path: 'src/core/fleet/a.ts' });
    expect(c.find(x => x.source === 'cli')?.title).toBe('phm cobalt');
    expect(readRepoName(root)).toBe('demo');
  });

  it('prints typed JSON, plain text, rejects bad flags, and writes nothing', async () => {
    const root = checkout();
    const before = JSON.stringify([readdirSync(root), readdirSync(join(root, 'docs'))]);
    const lines: string[] = [], errs: string[] = [];
    const deps = { root, out: (l: string) => lines.push(l), err: (l: string) => errs.push(l) };
    expect(await cmdBets(['propose', '--lane', 'claude', '--count', '2', '--json'], deps)).toBe(0);
    const report = JSON.parse(lines[0]!);
    expect(isBetsProposeReport(report)).toBe(true);
    expect(report).toMatchObject({ schema: 'bets.propose.v1', lane: 'claude', repo: 'demo', count: 2 });
    expect(report.proposals.length).toBeLessThanOrEqual(2);
    lines.length = 0;
    expect(await cmdBets(['propose'], deps)).toBe(0);
    expect(lines.join('\n')).toContain('Read-only');
    expect(await cmdBets(['propose', '--count', '0'], deps)).toBe(2);
    expect(await cmdBets(['propose', '--lane', 'Bad Lane'], deps)).toBe(2);
    expect(JSON.stringify([readdirSync(root), readdirSync(join(root, 'docs'))])).toBe(before);
  });
});

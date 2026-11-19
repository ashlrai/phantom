import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdBets } from '../src/cli/bets.js';
import { agentDocsText } from '../src/cli/help.js';
import { checkGoal, goalFromPrompt, goalTerms, helpItems, isBetsCheckReport, readApiRoutes, readDocHeadings, readPanes, type BetsCheckSources } from '../src/core/fleet/bets-check.js';

const sources = (): BetsCheckSources => ({
  cli: helpItems([
    { cmd: 'tools [--json] [--lane <lane>]', desc: 'Which lane has which tool, a parity score per lane and the top 3 gaps with a fix.' },
    { cmd: 'pulse merge-latency [--json]', desc: 'Where merge time goes per job phase, with the top wastes.' },
    { cmd: 'recut check [--json] <area>', desc: 'Should the next recut after a conflict launch? One plain line.' },
    { cmd: 'doctor [--json]', desc: 'Check the install.' },
  ]),
  api: [{ kind: 'api', name: '/api/verse/fleet/merge-pace', path: 'src/core/verse/merge-pace-api.ts', text: '' }],
  pane: [{ kind: 'pane', name: 'fleet-tools', path: 'src/web-ui/routes/verse/fleet-tools', text: '' }],
  doc: [{ kind: 'doc', name: 'Lane tool parity', path: 'docs/TOOLS.md', text: 'TOOLS' }],
});

describe('bets check', () => {
  it('finds the tool matrix as existing and names the one missing piece', () => {
    const r = checkGoal('lane-by-tool capability matrix CLI and pane', sources());
    expect(r.verdict).toBe('exists');
    expect(r.matches[0]).toMatchObject({ kind: 'cli', name: 'phm tools' });
    expect(r.matches.some(m => m.kind === 'pane' && m.name === 'fleet-tools')).toBe(true);
    expect(r.suggestedDelta).toContain('`phm tools`');
    expect(r.suggestedDelta).toContain('capability');
  });

  it('finds merge latency diagnosis with conflict recut as existing', () => {
    const r = checkGoal('merge latency diagnosis with conflict recut', sources());
    expect(r.verdict).toBe('exists');
    const names = r.matches.map(m => m.name);
    expect(names).toContain('phm pulse merge-latency');
    expect(names).toContain('phm recut check');
  });

  it('calls a made-up goal new, with no delta', () => {
    const r = checkGoal('quantum zebra harmonizer for llama choirs', sources());
    expect(r).toMatchObject({ verdict: 'new', matches: [], suggestedDelta: null });
  });

  it('says partial when only one word of the goal is covered', () => {
    const r = checkGoal('doctor for zebra llama choirs', sources());
    expect(r.verdict).toBe('partial');
    expect(r.suggestedDelta).toContain('build only that');
  });

  it('keeps at most 10 matches and drops filler words', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ kind: 'doc' as const, name: `Fleet notes ${i}`, path: `docs/N${i}.md`, text: '' }));
    expect(checkGoal('fleet notes', { ...sources(), doc: many }).matches).toHaveLength(10);
    expect(goalTerms('add a new CLI and pane for the tools').terms).toEqual(['tool']);
  });

  it('reads the checkout: routes, panes and headings', () => {
    const root = mkdtempSync(join(tmpdir(), 'bets-check-'));
    try {
      mkdirSync(join(root, 'src/core/verse'), { recursive: true });
      writeFileSync(join(root, 'src/core/verse/x-api.ts'), "if (path === '/api/verse/fleet/gadgets') {}\n");
      mkdirSync(join(root, 'src/web-ui/routes/verse/gadgets'), { recursive: true });
      mkdirSync(join(root, 'docs'));
      writeFileSync(join(root, 'docs/G.md'), '# Gadget guide\n```\n# not a heading\n```\n## Gadget limits\n');
      expect(readApiRoutes(root)).toEqual([{ kind: 'api', name: '/api/verse/fleet/gadgets', path: 'src/core/verse/x-api.ts', text: '' }]);
      expect(readPanes(root).map(p => p.name)).toEqual(['verse', 'gadgets']);
      expect(readDocHeadings(root).map(d => d.name)).toEqual(['Gadget guide', 'Gadget limits']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('CLI: --json validates against bets.check.v1 and the real help table finds phm tools', async () => {
    const lines: string[] = [];
    const code = await cmdBets(['check', 'lane-by-tool capability matrix CLI and pane', '--json'], { out: l => lines.push(l), err: () => {} });
    const report = JSON.parse(lines.join('\n'));
    expect(code).toBe(0);
    expect(isBetsCheckReport(report)).toBe(true);
    expect(report.verdict).toBe('exists');
    expect(report.matches.map((m: { name: string }) => m.name)).toContain('phm tools');
  });

  it('CLI: merge latency goal finds the real commands; no goal is a usage error', async () => {
    const lines: string[] = [];
    expect(await cmdBets(['check', 'merge latency diagnosis with conflict recut'], { out: l => lines.push(l), err: () => {} })).toBe(0);
    expect(lines.join('\n')).toMatch(/^exists:/);
    expect(lines.join('\n')).toContain('phm pulse merge-latency');
    expect(await cmdBets(['check'], { out: () => {}, err: () => {} })).toBe(2);
  });

  it('the agent cheat sheet tells job runners to check first', () => {
    expect(agentDocsText()).toContain('phm bets check');
  });

  describe('--gate and --from-prompt', () => {
    const prompt = (task: string): string => `Job X.\n\nTask from the queue, verbatim:\n\nRQ-X (P1, pool=claude, size<=200): ${task} Acceptance: tests pass.\n\nRules: be kind.\n`;
    const run = async (args: string[]): Promise<{ code: number; text: string; err: string }> => {
      const lines: string[] = [], errs: string[] = [];
      const code = await cmdBets(['check', ...args], { out: l => lines.push(l), err: l => errs.push(l) });
      return { code, text: lines.join('\n'), err: errs.join('\n') };
    };
    const withPrompt = async (task: string, extra: string[]): Promise<{ code: number; text: string; err: string }> => {
      const dir = mkdtempSync(join(tmpdir(), 'bets-gate-'));
      try { writeFileSync(join(dir, 'p.txt'), prompt(task)); return await run(['--from-prompt', join(dir, 'p.txt'), ...extra]); }
      finally { rmSync(dir, { recursive: true, force: true }); }
    };

    it('extracts the goal between the closing parenthesis and Acceptance', () => {
      expect(goalFromPrompt(prompt('Lane tool capability matrix.'))).toBe('Lane tool capability matrix.');
      expect(goalFromPrompt('no marker here')).toBeNull();
    });
    it('exits 0 for new, 2 for partial, 3 for exists, with the code in --json', async () => {
      const fresh = await run(['xyzzy plugh frobnitz', '--gate', '--json']);
      expect(fresh.code).toBe(0);
      expect(JSON.parse(fresh.text)).toMatchObject({ schema: 'bets.check.v1', verdict: 'new', exitCode: 0 });
      const part = await run(['doctor for zebra llama choirs', '--gate', '--json']);
      expect(part.code).toBe(2);
      expect(JSON.parse(part.text)).toMatchObject({ verdict: 'partial', exitCode: 2 });
      const done = await run(['lane-by-tool capability matrix CLI and pane', '--gate', '--json']);
      expect(done.code).toBe(3);
      expect(JSON.parse(done.text)).toMatchObject({ verdict: 'exists', exitCode: 3 });
    });
    it('reads a queue prompt in one step', async () => {
      const r = await withPrompt('Merge latency diagnosis with conflict recut.', ['--gate', '--json']);
      expect(r.code).toBe(3);
      expect(JSON.parse(r.text).goal).toBe('Merge latency diagnosis with conflict recut.');
      expect((await withPrompt('Xyzzy plugh frobnitz.', ['--gate'])).code).toBe(0);
    });
    it('exits 1 on errors in gate mode and never gates without --gate', async () => {
      expect((await run(['--from-prompt', '/nonexistent/prompt.txt', '--gate'])).code).toBe(1);
      expect((await run(['--gate'])).code).toBe(1);
      expect((await run(['doctor for zebra llama choirs'])).code).toBe(0);
    });
  });
});

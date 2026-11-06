import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyCommand, cmdFleetLoadWhy, summarizeProcesses } from '../src/cli/fleet-load-why.js';

const HEADER = '  PID  PPID STAT  %CPU    RSS     ELAPSED COMMAND\n';
const ps = (rows: string[]): string => HEADER + rows.join('\n') + '\n';
const host = { loadavg: [1.234, 2, 3], cores: 8 };

afterEach(() => vi.restoreAllMocks());

describe('classifyCommand', () => {
  it.each([
    ['/usr/bin/node /repo/node_modules/vitest/vitest.mjs run', 'vitest'],
    ['node /repo/node_modules/typescript/bin/tsc -p .', 'tsc'],
    ['/x/esbuild --service=0.1', 'esbuild'],
    ['node /home/u/.npm/mcp-server/index.js', 'node mcp'],
    ['node server.js', 'other'],
    ['/opt/bun run dev', 'bun'],
    ['cargo build', 'cargo'],
    ['/usr/local/bin/codex exec', 'codex'],
    ['claude --print mention vitest', 'claude'],
    ['devin serve', 'devin'],
    ['/usr/bin/git status', 'git'],
    ['/bin/zsh -l', 'other'],
  ])('%s -> %s', (cmd, kind) => expect(classifyCommand(cmd)).toBe(kind));
});

describe('summarizeProcesses', () => {
  it('counts orphans, busy states, cpu and memory per kind', () => {
    const r = summarizeProcesses(ps([
      '  10     1 R     1.5   2048     00:10 git status',
      '  11     1 D+    2.0   1024     00:10 git gc',
      '  12    10 S     0.0   1024     00:10 git log',
      '  13     5 S     3.0   4096     00:10 /bin/zsh',
      'garbage line',
    ]), host);
    expect(r).toMatchObject({ total: 4, orphans: 2, cores: 8, loadavg: [1.23, 2, 3] });
    expect(r.kinds[0]).toEqual({ kind: 'git', count: 3, orphans: 2, active: 2, cpu: 3.5, rssKb: 4096 });
    expect(r.kinds[1]!.kind).toBe('other');
  });

  it('keeps only the 10 biggest kinds', () => {
    const cmds = ['vitest', 'tsc', 'esbuild', 'bun', 'cargo', 'codex', 'claude', 'devin', 'git', 'zsh', 'node mcp.js'];
    const r = summarizeProcesses(ps(cmds.map((c, i) => `${i + 1} 5 S 0.0 1 00:01 ${c}`)), host);
    expect(r.kinds).toHaveLength(10);
  });
});

describe('cmdFleetLoadWhy', () => {
  const run = async (args: string[], rows: string[] | Error) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await cmdFleetLoadWhy(args, {
      runner: async () => { if (rows instanceof Error) throw rows; return ps(rows); },
      loadavg: () => [0.5, 0.5, 0.5], cores: () => 4,
    });
    return { code, out: log.mock.calls.map(c => String(c[0])).join('\n') };
  };

  it('prints json and exits 0 at exactly 100 orphans', async () => {
    const { code, out } = await run(['--json'], Array.from({ length: 100 }, (_, i) => `${i + 2} 1 S 0.1 10 00:01 git x`));
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ cores: 4, orphans: 100, loadavg: [0.5, 0.5, 0.5] });
  });

  it('exits 1 when orphans pass 100', async () => {
    const { code } = await run(['--json'], Array.from({ length: 101 }, (_, i) => `${i + 2} 1 S 0.1 10 00:01 git x`));
    expect(code).toBe(1);
  });

  it('prints plain words without --json', async () => {
    const { code, out } = await run([], ['2 1 R 1.0 2048 00:01 cargo build']);
    expect(code).toBe(0);
    expect(out).toContain('Load 0.5 0.5 0.5 on 4 cores');
    expect(out).toContain('cargo');
  });

  it('exits 2 on a bad flag or a ps failure', async () => {
    expect((await run(['--nope'], [])).code).toBe(2);
    expect((await run([], new Error('boom'))).code).toBe(2);
  });
});

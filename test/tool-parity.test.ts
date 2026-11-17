import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildToolMatrix, buildToolParity, formatToolMatrix, formatToolParity, formatToolRequires, loadToolParity, parseToolNeeds,
  toolRequires, TOOL_CAPABILITIES, type ToolParityReaders,
} from '../src/core/fleet/tool-parity.js';
import { cmdTools } from '../src/cli/tools.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'tool-parity');
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

/** A temp runs dir with an optional lane-tools fixture and slots.json, plus an empty temp home. */
async function scene(laneTools?: string, slots = false, profile?: string): Promise<{ runsDir: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), 'tool-parity-'));
  dirs.push(root);
  const runsDir = join(root, 'runs');
  const home = join(root, 'home');
  await mkdir(join(runsDir, 'queue'), { recursive: true });
  await mkdir(home);
  if (laneTools) await copyFile(join(FIXTURES, laneTools), join(runsDir, 'queue', 'lane-tools.json'));
  if (slots) await copyFile(join(FIXTURES, 'slots.json'), join(runsDir, 'queue', 'slots.json'));
  if (profile) { await mkdir(join(home, '.phantom', 'connectors'), { recursive: true }); await writeFile(join(home, '.phantom', 'connectors', 'profile.toml'), profile); }
  return { runsDir, home };
}

describe('phm tools parity', () => {
  it('reports full parity when every lane declares every tool and the same MCP servers', async () => {
    const report = await loadToolParity(await scene('full.json'));
    expect(report.parity).toBe('full');
    expect(report.gaps).toEqual([]);
    expect(report.unknown).toEqual([]);
    expect(report.mcpServers).toEqual(['context7', 'fetch']);
    expect(report.lanes.map(l => l.lane)).toEqual(['claude', 'codex-cmp']);
    // lane-tools.json overrides the router's claude gh=false declaration.
    expect(report.lanes[0]!.capabilities['github-read']).toBe('yes');
    expect(report.lanes[0]!.mcp).toEqual(['context7', 'fetch']);
    expect(report.sources).toEqual([
      { name: 'router', state: 'declared' }, { name: 'connectors', state: 'missing' },
      { name: 'lane-tools.json', state: 'healthy' }, { name: 'slots.json', state: 'missing' },
    ]);
  });

  it('shows one missing capability as a gap: the router declares claude without GitHub', async () => {
    const report = await loadToolParity(await scene('one-missing.json'));
    expect(report.parity).toBe('gaps');
    expect(report.gaps).toEqual([{ need: 'github-read', lanes: ['claude'] }]);
    expect(report.unknown).toEqual([]);
    const text = formatToolParity(report);
    expect(text).toContain('Missing: github-read (claude)');
    expect(text).toMatch(/^claude\s+no\s+yes/m);
  });

  it('keeps undeclared capabilities unknown, never missing, and ignores non-boolean values', async () => {
    const report = await loadToolParity(await scene('unknown.json', true));
    expect(report.parity).toBe('unknown');
    expect(report.gaps).toEqual([]);
    // codex-local comes from slots.json alone, so all of its tools are unknown.
    const local = report.lanes.find(l => l.lane === 'codex-local')!;
    expect(Object.values(local.capabilities)).toEqual(Array(TOOL_CAPABILITIES.length).fill('unknown'));
    expect(local.mcp).toBeNull();
    expect(report.lanes.find(l => l.lane === 'gemini')!.capabilities['github-read']).toBe('unknown');
    expect(report.unknown.find(u => u.need === 'mcp:context7')).toEqual({ need: 'mcp:context7', lanes: ['claude', 'codex-local', 'gemini'] });
    expect(report.unknown.find(u => u.need === 'github-read')).toEqual({ need: 'github-read', lanes: ['codex-local', 'gemini'] });
    expect(formatToolParity(report)).toMatch(/^codex-local(\s+\?){7}\s+\?$/m);
  });

  it('reads MCP servers per lane from connectors that name the lane and skips unrestricted ones', async () => {
    const profile = [
      'version = 1',
      '[[connectors]]\nid = "linear"\nkind = "mcp-http"\nurl = "https://mcp.linear.app/sse"\nlanes = ["codex-cmp"]',
      '[[connectors]]\nid = "anywhere"\nkind = "mcp-stdio"\ncommand = "npx"\nlanes = []',
    ].join('\n');
    const report = await loadToolParity(await scene('full.json', false, profile));
    expect(report.lanes.find(l => l.lane === 'codex-cmp')!.mcp).toEqual(['context7', 'fetch', 'linear']);
    expect(report.gaps).toEqual([{ need: 'mcp:linear', lanes: ['claude'] }]);
    expect(report.mcpServers).not.toContain('anywhere');
  });

  it('degrades a malformed lane-tools.json instead of guessing', async () => {
    const s = await scene();
    await writeFile(join(s.runsDir, 'queue', 'lane-tools.json'), '{"v":2}');
    const report = await loadToolParity(s);
    expect(report.sources.find(x => x.name === 'lane-tools.json')!.state).toBe('degraded');
    expect(report.gaps).toEqual([{ need: 'github-read', lanes: ['claude'] }]);
  });

  it('emits stable JSON regardless of declaration order', () => {
    const a = buildToolParity({ lanes: ['zai', 'claude'], sources: [{ name: 'lane-tools.json', lanes: { gemini: { mcp: ['b', 'a'] }, claude: { capabilities: { shell: true } } } }] });
    const b = buildToolParity({ lanes: ['claude', 'zai'], sources: [{ name: 'lane-tools.json', lanes: { claude: { capabilities: { shell: true } }, gemini: { mcp: ['a', 'b'] } } }] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a)).toEqual(['schema', 'parity', 'capabilities', 'mcpServers', 'needs', 'lanes', 'gaps', 'unknown', 'sources']);
    expect(Object.keys(a.lanes[0]!.capabilities)).toEqual([...TOOL_CAPABILITIES]);
  });

  it('fits --text in 20 lines even with many lanes', () => {
    const lanes = Array.from({ length: 40 }, (_, i) => `lane-${String(i).padStart(2, '0')}`);
    const report = buildToolParity({
      lanes, sources: [{ name: 'router', lanes: { 'lane-00': { capabilities: { 'github-read': false } } } }],
      states: [{ name: 'router', state: 'declared' }, { name: 'slots.json', state: 'degraded' }],
    });
    const lines = formatToolParity(report).split('\n');
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines).toContain('Could not read: slots.json; their lanes and tools are not shown.');
    expect(lines).toContain('… 26 more lane(s); use JSON for all.');
  });
});

describe('phm tools requires', () => {
  it('lists lanes that can, might and cannot run a job', async () => {
    const report = await loadToolParity(await scene('unknown.json', true));
    const result = toolRequires(report, ['github-read', 'browser']);
    expect(result).toEqual({
      schema: 'tools.requires.v1', needs: ['github-read', 'browser'], can: ['codex-cmp'],
      unproven: [{ lane: 'claude', unknown: ['browser'] }, { lane: 'codex-local', unknown: ['github-read', 'browser'] }, { lane: 'gemini', unknown: ['github-read'] }],
      cannot: [],
    });
    const gapped = toolRequires(await loadToolParity(await scene('one-missing.json')), ['github-read', 'mcp:context7']);
    expect(gapped.can).toEqual(['codex-cmp']);
    expect(gapped.cannot).toEqual([{ lane: 'claude', lacks: ['github-read'] }]);
    expect(formatToolRequires(gapped)).toContain('Cannot run: claude (lacks github-read)');
  });

  it('parses needs strictly', () => {
    expect(parseToolNeeds('github-read, browser,github-read')).toEqual({ needs: ['github-read', 'browser'] });
    expect(parseToolNeeds('mcp:context7')).toEqual({ needs: ['mcp:context7'] });
    expect(parseToolNeeds('gh')).toHaveProperty('error');
    expect(parseToolNeeds(' , ')).toHaveProperty('error');
  });

  it('CLI: JSON by default, exit 1 when every lane is declared to lack a need, 2 on bad usage', async () => {
    const s = await scene('one-missing.json');
    vi.stubEnv('ASHLR_RUNS_DIR', s.runsDir);
    vi.stubEnv('HOME', s.home);
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((v: unknown) => { out.push(String(v)); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdTools(['parity'])).toBe(0);
    expect(JSON.parse(out.pop()!).schema).toBe('tools.parity.v1');
    expect(await cmdTools(['requires', '--needs', 'github-read'])).toBe(0);
    expect(JSON.parse(out.pop()!).can).toEqual(['codex-cmp']);
    expect(await cmdTools(['requires', '--needs', 'mcp:linear', '--text'])).toBe(1);
    expect(out.pop()).toContain('Can run: none');
    expect(await cmdTools(['requires'])).toBe(2);
    expect(await cmdTools(['requires', '--needs', 'nope'])).toBe(2);
    expect(await cmdTools(['bogus'])).toBe(2);
    expect(await cmdTools(['--help'])).toBe(0);
    vi.unstubAllEnvs();
  });
});

/** Readers over fixtures only: no disk paths, no home, no runs dir. */
const FLEET = ['claude', 'claude-api', 'codex-cmp', 'codex-local', 'codex-personal', 'devin', 'gemini', 'zai'];
function readers(laneTools: string | null | (() => Promise<string | null>), extra: Partial<ToolParityReaders> = {}): ToolParityReaders {
  return {
    connectors: async () => [],
    laneTools: typeof laneTools === 'function' ? laneTools : async () => (laneTools === null ? null : readFileSync(join(FIXTURES, laneTools), 'utf8')),
    slots: async () => ({ lanes: FLEET, sourceState: 'healthy' }),
    ...extra,
  };
}
const fixtureMatrix = async (laneTools: string, lane?: string) => buildToolMatrix(await loadToolParity({ readers: readers(laneTools) }), lane)!;

describe('phm tools (matrix)', () => {
  it('full parity: every lane scores 100 and there are no gaps', async () => {
    const matrix = await fixtureMatrix('fleet-full.json');
    expect(matrix.parity).toBe('full');
    expect(matrix.lanes).toEqual(FLEET);
    expect(matrix.rows.map(r => r.need)).toEqual([...TOOL_CAPABILITIES, 'mcp:context7', 'mcp:fetch', 'cli:phm', 'skill:review', 'plugin:ashlr']);
    expect(matrix.scores.every(s => s.score === 100 && s.no === 0 && s.unknown === 0)).toBe(true);
    expect(matrix.topGaps).toEqual([]);
    // lane-tools.json overrides the router's claude gh=false, and the cell names its source.
    expect(matrix.rows[0]!.cells.claude).toEqual({ value: 'yes', source: 'lane-tools.json' });
    expect(formatToolMatrix(matrix)).toContain('Top gaps: none.');
  });

  it('local lane missing browser: one gap, lower score, a plain fix', async () => {
    const matrix = await fixtureMatrix('fleet-local-no-browser.json');
    expect(matrix.parity).toBe('gaps');
    expect(matrix.rows.find(r => r.need === 'browser')!.cells['codex-local']).toEqual({ value: 'no', source: 'lane-tools.json' });
    expect(matrix.scores.find(s => s.lane === 'codex-local')).toEqual({ lane: 'codex-local', score: 92, yes: 11, no: 1, unknown: 0 });
    expect(matrix.topGaps).toEqual([{
      need: 'browser', label: 'Browser', state: 'missing', lanes: ['codex-local'],
      fix: 'Add Browser to the launch config of codex-local, then set "browser": true in <runs>/queue/lane-tools.json.',
    }]);
    expect(formatToolMatrix(matrix)).toContain('1. Browser missing on codex-local.');
    const one = await fixtureMatrix('fleet-local-no-browser.json', 'codex-local');
    expect(one.lanes).toEqual(['codex-local']);
    expect(Object.keys(one.rows[0]!.cells)).toEqual(['codex-local']);
    expect(formatToolMatrix(one, 'codex-local')).toMatch(/^ {2}no {2}Browser {2}\(lane-tools\.json\)$/m);
  });

  it('unknown config: unreadable or absent declarations are unknown, never missing', async () => {
    for (const laneTools of [async () => { throw new Error('unreadable'); }, null, async () => '{"v":2}']) {
      const report = await loadToolParity({ readers: readers(laneTools, { connectors: async () => { throw new Error('bad profile'); } }) });
      const matrix = buildToolMatrix(report)!;
      expect(matrix.parity).toBe('gaps');
      // Only the router's built-in claude gh=false is a declared gap; everything else is unknown.
      expect(matrix.topGaps[0]).toMatchObject({ need: 'github-read', state: 'missing', lanes: ['claude'] });
      expect(matrix.topGaps.slice(1)).toEqual([
        { need: 'github-write', label: 'GitHub write', state: 'unknown', lanes: FLEET, fix: 'Check GitHub write on 8 lanes and record yes or no in <runs>/queue/lane-tools.json.' },
        { need: 'web-search', label: 'Web search', state: 'unknown', lanes: FLEET, fix: 'Check Web search on 8 lanes and record yes or no in <runs>/queue/lane-tools.json.' },
      ]);
      expect(matrix.scores.find(s => s.lane === 'zai')).toEqual({ lane: 'zai', score: 0, yes: 0, no: 0, unknown: TOOL_CAPABILITIES.length });
      expect(matrix.rows.find(r => r.need === 'browser')!.cells.zai).toEqual({ value: 'unknown', source: null });
      expect(report.sources.find(s => s.name === 'connectors')!.state).toBe('degraded');
    }
  });

  it('a new capability appearing on one lane becomes a row and a gap where others declare a list', async () => {
    const base = JSON.parse(readFileSync(join(FIXTURES, 'fleet-full.json'), 'utf8')) as { lanes: Record<string, { skill: string[] }> };
    base.lanes.claude!.skill = ['review', 'triage'];
    const matrix = buildToolMatrix(await loadToolParity({ readers: readers(async () => JSON.stringify(base), {
      connectors: async () => [{ id: 'docs', kind: 'mcp-http', lanes: ['devin'] }, { id: 'ignored', kind: 'mcp-stdio', lanes: [] }],
    }) }))!;
    expect(matrix.rows.map(r => r.need)).toContain('skill:triage');
    expect(matrix.rows.map(r => r.need)).not.toContain('mcp:ignored');
    expect(matrix.rows.find(r => r.need === 'mcp:docs')!.cells.devin).toEqual({ value: 'yes', source: 'connectors' });
    expect(matrix.topGaps.map(g => [g.need, g.lanes.length])).toEqual([['mcp:docs', 7], ['skill:triage', 7]]);
    expect(matrix.topGaps[1]!.fix).toBe('Add Skill triage to the launch config of 7 lanes, then list "triage" under "skill" in <runs>/queue/lane-tools.json.');
    expect(matrix.scores.find(s => s.lane === 'claude')!.score).toBe(93);
  });

  it('emits stable JSON with a fixed key order', async () => {
    const a = await fixtureMatrix('fleet-local-no-browser.json');
    const shuffled = readers(async () => {
      const raw = JSON.parse(readFileSync(join(FIXTURES, 'fleet-local-no-browser.json'), 'utf8')) as { v: 1; lanes: Record<string, { mcp: string[] }> };
      const lanes = Object.fromEntries(Object.entries(raw.lanes).reverse().map(([k, v]) => [k, { ...v, mcp: [...v.mcp].reverse() }]));
      return JSON.stringify({ v: 1, lanes });
    }, { slots: async () => ({ lanes: [...FLEET].reverse(), sourceState: 'healthy' }) });
    const b = buildToolMatrix(await loadToolParity({ readers: shuffled }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a)).toEqual(['schema', 'parity', 'lanes', 'rows', 'scores', 'topGaps', 'sources']);
    expect(buildToolMatrix(await loadToolParity({ readers: readers('fleet-full.json') }), 'nope')).toBeNull();
  });

  it('CLI: text by default, --json, --lane, exit 2 for an unknown lane or bad flag', async () => {
    const s = await scene('one-missing.json');
    vi.stubEnv('ASHLR_RUNS_DIR', s.runsDir);
    vi.stubEnv('HOME', s.home);
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((v: unknown) => { out.push(String(v)); });
    vi.spyOn(console, 'error').mockImplementation((v: unknown) => { err.push(String(v)); });
    expect(await cmdTools([])).toBe(0);
    expect(out.pop()).toMatch(/^Tools: 2 lane\(s\), 9 tool\(s\), parity gaps\./);
    expect(await cmdTools(['--json'])).toBe(0);
    expect(JSON.parse(out.pop()!).schema).toBe('tools.matrix.v1');
    expect(await cmdTools(['--lane', 'claude', '--json'])).toBe(0);
    expect(JSON.parse(out.pop()!).lanes).toEqual(['claude']);
    expect(await cmdTools(['--lane', 'nope'])).toBe(2);
    expect(err.pop()).toBe('No lane "nope". Known lanes: claude, codex-cmp.');
    expect(await cmdTools(['--lane'])).toBe(2);
    expect(await cmdTools(['--verbose'])).toBe(2);
    vi.unstubAllEnvs();
  });
});

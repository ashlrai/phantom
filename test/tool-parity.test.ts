import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildToolParity, formatToolParity, formatToolRequires, loadToolParity, parseToolNeeds, toolRequires, TOOL_CAPABILITIES,
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
    expect(formatToolParity(report)).toMatch(/^codex-local(\s+\?){6}\s+\?$/m);
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
    expect(Object.keys(a)).toEqual(['schema', 'parity', 'capabilities', 'mcpServers', 'lanes', 'gaps', 'unknown', 'sources']);
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

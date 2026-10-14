import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PARITY } from '../src/core/parity.js';
import { nativeToolDefs } from '../src/core/mcp-native.js';
import { ALL_NAV_LEAVES } from '../src/web-ui/app/nav-config.js';
import { SETTINGS_KEYS, type SettingsBackend, type SettingsV1 } from '../src/core/settings/settings.js';
import { runEcosystemUp, type EcosystemDeps } from '../src/core/ecosystem/onboard.js';
import { buildHomeDashboard, type HomeSources } from '../src/core/home/dashboard.js';

const api = readFileSync(new URL('../src/core/web/api.ts', import.meta.url), 'utf8');
const cliIndex = readFileSync(new URL('../src/cli/index.ts', import.meta.url), 'utf8');
const ecoCli = readFileSync(new URL('../src/cli/ecosystem.ts', import.meta.url), 'utf8');

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { out += String(c); return true; });
  try { return { code: await fn(), out }; } finally { spy.mockRestore(); }
}

describe('UI ⇄ CLI ⇄ MCP parity', () => {
  const tools = new Map(nativeToolDefs().map((t) => [t.name, t]));

  it.each(PARITY.map((p) => [p.capability, p] as const))('%s exists on console, API, CLI and MCP', (_n, p) => {
    expect(ALL_NAV_LEAVES.some((l) => l.path === p.consolePath)).toBe(true);
    expect(api).toContain(`path === '${p.api.path}' && method === '${p.api.method}'`);
    const sub = p.cli.split(' ')[1]!;
    expect(cliIndex.includes(`case '${sub}'`) || (sub === 'ecosystem' && ecoCli.includes("args[0] === 'up'"))).toBe(true);
    expect(p.cli).toContain('--json');
    expect(tools.has(p.mcp)).toBe(true);
    if (p.api.method === 'GET') expect((tools.get(p.mcp) as { safety?: string }).safety).toBe('read');
    else expect((tools.get(p.mcp) as { safety?: string }).safety).not.toBe('read');
  });

  it('every new console page has a parity entry', () => {
    for (const path of ['/home', '/control/ecosystem', '/control/settings']) expect(PARITY.some((p) => p.consolePath === path)).toBe(true);
  });

  it('MCP settings_set accepts exactly the CLI/console keys', () => {
    const schema = tools.get('ashlr_settings_set')!.inputSchema as { properties: { key: { enum: string[] } } };
    expect([...schema.properties.key.enum].sort()).toEqual([...SETTINGS_KEYS].sort());
  });

  it('CLI --json equals the shared core output (settings, home, ecosystem)', async () => {
    const s = { schemaVersion: 1, kind: 'ashlr-settings', autonomy: { level: 'off', grantActive: false, maxLevel: 'propose' }, repos: { enrolled: [] }, schedules: [], models: { allowedEngines: null }, budget: { dailyUsd: 1, perItemMaxTokens: null, maxConcurrent: null }, notifications: { desktop: false, proactive: false, slack: false, discord: false }, constitution: { path: null, versions: [] } } satisfies SettingsV1;
    const be: SettingsBackend = { read: async () => s, apply: async () => ({ ok: true, detail: 'saved' }) };
    const { cmdSettings } = await import('../src/cli/settings.js');
    expect(JSON.parse((await capture(() => cmdSettings(['--json'], be))).out)).toEqual(await be.read());

    const src: HomeSources = { now: () => new Date('2026-10-13T12:00:00Z'), mergedPrs: async () => ({ prs: [] }), runs: async () => ({ runs: [] }), pendingProposals: async () => [], onboardingNext: async () => null };
    const { cmdHome } = await import('../src/cli/home.js');
    expect(JSON.parse((await capture(() => cmdHome(['--json'], src))).out)).toEqual(JSON.parse(JSON.stringify(await buildHomeDashboard(src))));

    const deps: EcosystemDeps = { now: () => new Date('2026-10-13T12:00:00Z'), exists: () => false, run: async () => ({ code: 1, stdout: '', stderr: '' }), clone: async () => ({ code: 1, stdout: '', stderr: '' }), listEnrolled: () => [], enroll: () => ({ ok: false, changed: false }), grantState: async () => ({ state: 'none', repos: [], grantSeq: null, eliteDirect: false }), automations: { list: async () => [], createFromTemplate: async () => ({ id: 'x' }), enable: async () => {} }, residentState: async () => 'absent' };
    const { cmdEcosystemUp } = await import('../src/cli/ecosystem-up.js');
    const cli = JSON.parse((await capture(() => cmdEcosystemUp(['status', '--json', '--workspace', '/ws'], deps))).out);
    expect(cli).toEqual(JSON.parse(JSON.stringify(await runEcosystemUp(deps, { workspace: '/ws', statusOnly: true }))));
  });

  it('agent limits are enforced, not just documented', async () => {
    const { applySettingsChange } = await import('../src/core/settings/settings.js');
    const be: SettingsBackend = { read: async () => ({ autonomy: { level: 'propose', grantActive: true, maxLevel: 'autonomous' }, budget: { dailyUsd: 1 } }) as never, apply: async () => ({ ok: true, detail: 'x' }) };
    expect((await applySettingsChange(be, { key: 'budget.dailyUsd', value: 9 }, 'agent')).status).toBe('needs-human');
    expect(PARITY.find((p) => p.mcp === 'ashlr_ecosystem_up')!.agentLimit).toBe('no-grant-signing');
    expect(api).toMatch(/runEcosystemUp\(await realEcosystemDeps\(\{ withGrant: false \}\), \{ allowGrant: false \}\)/);
  });
});

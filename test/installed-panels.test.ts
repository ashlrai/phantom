import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatInstalledPanel, readPluginsPanel, readSkillsPanel } from '../src/core/fleet/installed-panels.js';
import type { SkillListReport } from '../src/core/fleet/skill-list.js';

const now = () => new Date('2026-11-17T12:00:00Z');
const homes: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'installed-panels-'));
  homes.push(dir);
  return dir;
}
function put(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}
const noLearned = (): SkillListReport => ({ schemaVersion: 1, matched: 0, returned: 0, total: 0, corpus: 'missing', invalidRows: 0, skills: [] });
/** root ignores mode bits, so a file where a folder belongs stands in for an unreadable source. */
function unreadableDir(path: string): void { put(path, 'not a directory'); }

afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('readPluginsPanel', () => {
  it('reports an empty home as no plugins, with no rows', () => {
    const panel = readPluginsPanel({ home: home(), now, enabledPlugins: () => [] });
    expect(panel).toEqual({ schema: 'fleet.plugins-panel.v1', observedAt: '2026-11-17T12:00:00.000Z', items: [],
      sources: [{ source: 'Phantom', state: 'none', count: 0 }, { source: 'Claude Code', state: 'none', count: 0 }] });
  });

  it('marks unreadable sources unknown and never invents rows', () => {
    const h = home();
    unreadableDir(join(h, '.ashlr', 'plugins'));
    put(join(h, '.claude', 'plugins', 'installed_plugins.json'), '{not json');
    const panel = readPluginsPanel({ home: h, now, enabledPlugins: () => [] });
    expect(panel.items).toEqual([]);
    expect(panel.sources.map(s => s.state)).toEqual(['unknown', 'unknown']);
    expect(formatInstalledPanel(panel, 'plugins')).toContain('Phantom: unknown (could not read)');
  });

  it('lists Phantom and Claude Code plugins with who has them and whether they are on', () => {
    const h = home();
    put(join(h, '.ashlr', 'plugins', 'scan', 'manifest.json'), JSON.stringify({ name: 'scan', version: '0.1.0', apiVersion: '1.0.0', entry: './index.mjs', capabilities: ['scanner'] }));
    put(join(h, '.ashlr', 'plugins', 'broken', 'manifest.json'), '{}');
    put(join(h, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
      'review@official': [{ scope: 'user' }], 'local@team': [{ scope: 'project' }], 'quiet@official': [{ scope: 'user' }] } }));
    put(join(h, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'review@official': true, 'local@team': false } }));
    const panel = readPluginsPanel({ home: h, now, enabledPlugins: () => ['scan'] });
    expect(panel.items).toEqual([
      { name: 'broken', source: 'Phantom', agents: 'None (invalid manifest)', enabled: false, lastUsed: 'unknown' },
      { name: 'local', source: 'Claude Code (team)', agents: 'Claude lanes in one project', enabled: false, lastUsed: 'unknown' },
      { name: 'quiet', source: 'Claude Code (official)', agents: 'Claude lanes', enabled: 'unknown', lastUsed: 'unknown' },
      { name: 'review', source: 'Claude Code (official)', agents: 'Claude lanes', enabled: true, lastUsed: 'unknown' },
      { name: 'scan', source: 'Phantom', agents: 'Any agent that runs phm on this machine', enabled: true, lastUsed: 'unknown' },
    ]);
    expect(panel.sources).toEqual([{ source: 'Phantom', state: 'read', count: 2 }, { source: 'Claude Code', state: 'read', count: 3 }]);
  });

  it('says enabled is unknown when Phantom config cannot be read', () => {
    const h = home();
    put(join(h, '.ashlr', 'plugins', 'scan', 'manifest.json'), JSON.stringify({ name: 'scan', version: '0.1.0', apiVersion: '1.0.0', entry: './index.mjs', capabilities: ['command'] }));
    const panel = readPluginsPanel({ home: h, now, enabledPlugins: () => { throw new Error('bad config'); } });
    expect(panel.items[0]).toMatchObject({ name: 'scan', enabled: 'unknown' });
  });
});

describe('readSkillsPanel', () => {
  it('reports an empty home as no skills, with no rows', () => {
    const panel = readSkillsPanel({ home: home(), now, learnedSkills: noLearned });
    expect(panel.items).toEqual([]);
    expect(panel.sources).toEqual([
      { source: 'Claude Code', state: 'none', count: 0 },
      { source: 'Codex', state: 'none', count: 0 },
      { source: 'Learned from merged PRs', state: 'none', count: 0 },
    ]);
  });

  it('marks unreadable sources unknown and never invents rows', () => {
    const h = home();
    unreadableDir(join(h, '.claude', 'skills'));
    unreadableDir(join(h, '.codex', 'skills'));
    const panel = readSkillsPanel({ home: h, now, learnedSkills: () => { throw new Error('corpus unreadable'); } });
    expect(panel.items).toEqual([]);
    expect(panel.sources.map(s => s.state)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('lists Claude Code, Codex and learned skills; hidden folders and files are skipped', () => {
    const h = home();
    put(join(h, '.claude', 'skills', 'deploy', 'SKILL.md'), '# deploy');
    put(join(h, '.claude', 'skills', 'notes.md'), 'not a skill');
    put(join(h, '.codex', 'skills', '.system', 'x', 'SKILL.md'), '# system');
    put(join(h, '.codex', 'skills', 'triage', 'SKILL.md'), '# triage');
    const learned = (): SkillListReport => ({ ...noLearned(), corpus: 'healthy', matched: 1, returned: 1, total: 1, skills: [{
      skillId: 's1', revision: 1, name: 'fix flaky test', summary: '', status: 'candidate', source: 'verified-proposal', updatedAt: '2026-11-16T00:00:00Z',
      taskKinds: [], commandKinds: [], verificationPassed: true, evidenceCount: 1, proposalId: 'p1', attestationPresent: true }] });
    const panel = readSkillsPanel({ home: h, now, learnedSkills: learned });
    expect(panel.items).toEqual([
      { name: 'deploy', source: 'Claude Code', agents: 'Claude lanes', enabled: true, lastUsed: 'unknown' },
      { name: 'fix flaky test', source: 'Learned from merged PRs', agents: 'No lane yet (observe-only)', enabled: false, lastUsed: 'unknown' },
      { name: 'triage', source: 'Codex', agents: 'Codex lanes', enabled: true, lastUsed: 'unknown' },
    ]);
  });
});

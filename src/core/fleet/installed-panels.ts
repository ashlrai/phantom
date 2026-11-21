export const INVALID_MANIFEST_AGENTS = 'None (invalid manifest)';
/**
 * installed-panels.ts: what plugins and skills fleet agents have, for the
 * desktop Plugins and Skills panes and `phm plugins|skills list --all --json`.
 *
 * Read-only, never throws, never imports plugin code. Every row comes from a
 * file that exists; a source that cannot be read is reported as 'unknown' and
 * contributes no rows. Nothing records when a plugin or skill was last used,
 * so `lastUsed` is 'unknown' until such a record exists.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfigReadOnlyStrict } from '../config.js';
import { readManifest } from '../plugins/manifest.js';
import { listSkills, SKILL_LIST_MAX_LIMIT, type SkillListReport } from './skill-list.js';

export interface InstalledItem {
  name: string;
  source: string;
  /** Plain words: which lanes or agents get it. */
  agents: string;
  enabled: boolean | 'unknown';
  lastUsed: string | 'unknown';
}

/** read: listed; none: nothing installed there; unknown: present but unreadable. */
export interface InstalledSource { source: string; state: 'read' | 'none' | 'unknown'; count: number }

export interface InstalledPanel {
  schema: 'fleet.plugins-panel.v1' | 'fleet.skills-panel.v1';
  observedAt: string;
  sources: InstalledSource[];
  items: InstalledItem[];
}

export interface InstalledPanelOptions {
  home?: string;
  now?: () => Date;
  /** Phantom's enabled plugin names; throws when the config is unreadable. */
  enabledPlugins?: () => string[];
  /** Learned skill corpus (defaults to the same reader as `phm skills list`). */
  learnedSkills?: () => SkillListReport;
}

/** What `agents` says for a Phantom plugin whose manifest does not parse. */
export const INVALID_MANIFEST_AGENTS = 'None (invalid manifest)';
/** The `source` of Phantom's learned skill cards. */
export const LEARNED_SKILLS_SOURCE = 'Learned from merged PRs';

type Read<T> = { state: 'read'; value: T } | { state: 'none' | 'unknown' };

const missing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

function readJson(path: string): Read<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? { state: 'read', value: value as Record<string, unknown> } : { state: 'unknown' };
  } catch (err) { return { state: missing(err) ? 'none' : 'unknown' }; }
}

/** Visible subdirectories of `dir`, sorted. */
function readDirs(dir: string): Read<string[]> {
  try {
    const names = readdirSync(dir).filter(name => !name.startsWith('.')).sort();
    return { state: 'read', value: names.filter(name => { try { return statSync(join(dir, name)).isDirectory(); } catch { return false; } }) };
  } catch (err) { return { state: missing(err) ? 'none' : 'unknown' }; }
}

function collect(schema: InstalledPanel['schema'], now: Date, parts: Array<{ source: string; read: Read<InstalledItem[]> }>): InstalledPanel {
  const items = parts.flatMap(part => part.read.state === 'read' ? part.read.value : []);
  return {
    schema,
    observedAt: now.toISOString(),
    sources: parts.map(part => ({ source: part.source, state: part.read.state === 'read' && part.read.value.length === 0 ? 'none' : part.read.state, count: part.read.state === 'read' ? part.read.value.length : 0 })),
    items: items.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source)),
  };
}

function phantomPlugins(home: string, enabledPlugins: () => string[]): Read<InstalledItem[]> {
  const root = join(home, '.ashlr', 'plugins');
  const dirs = readDirs(root);
  if (dirs.state !== 'read') return dirs;
  let enabled: Set<string> | null;
  try { enabled = new Set(enabledPlugins()); } catch { enabled = null; }
  return { state: 'read', value: dirs.value.map(dir => {
    const manifest = readManifest(join(root, dir));
    if (!manifest.ok) return { name: dir, source: 'Phantom', agents: INVALID_MANIFEST_AGENTS, enabled: false, lastUsed: 'unknown' };
    const name = manifest.manifest.name;
    return { name, source: 'Phantom', agents: 'Any agent that runs phm on this machine', enabled: enabled ? enabled.has(name) : 'unknown', lastUsed: 'unknown' };
  }) };
}

function claudePlugins(home: string): Read<InstalledItem[]> {
  const installed = readJson(join(home, '.claude', 'plugins', 'installed_plugins.json'));
  if (installed.state !== 'read') return installed;
  const plugins = installed.value['plugins'];
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return { state: 'unknown' };
  const settings = readJson(join(home, '.claude', 'settings.json'));
  const flags = settings.state === 'read' ? settings.value['enabledPlugins'] as Record<string, unknown> | undefined : undefined;
  return { state: 'read', value: Object.entries(plugins as Record<string, unknown>).map(([key, installs]) => {
    const at = key.lastIndexOf('@');
    const scopes = Array.isArray(installs) ? installs.map(i => (i as { scope?: unknown })?.scope).filter(s => typeof s === 'string') : [];
    const flag = flags?.[key];
    return {
      name: at > 0 ? key.slice(0, at) : key,
      source: at > 0 ? `Claude Code (${key.slice(at + 1)})` : 'Claude Code',
      agents: scopes.length > 0 && scopes.every(s => s !== 'user') ? 'Claude lanes in one project' : 'Claude lanes',
      enabled: typeof flag === 'boolean' ? flag : 'unknown',
      lastUsed: 'unknown',
    };
  }) };
}

/** Plugins: Phantom's own (~/.ashlr/plugins) and Claude Code's installed list. */
export function readPluginsPanel(opts: InstalledPanelOptions = {}): InstalledPanel {
  const home = opts.home ?? homedir();
  const enabledPlugins = opts.enabledPlugins ?? (() => loadConfigReadOnlyStrict().plugins?.enabled ?? []);
  return collect('fleet.plugins-panel.v1', opts.now?.() ?? new Date(), [
    { source: 'Phantom', read: phantomPlugins(home, enabledPlugins) },
    { source: 'Claude Code', read: claudePlugins(home) },
  ]);
}

function skillDirs(root: string, source: string, agents: string): Read<InstalledItem[]> {
  const dirs = readDirs(root);
  if (dirs.state !== 'read') return dirs;
  return { state: 'read', value: dirs.value.map(name => ({ name, source, agents, enabled: true, lastUsed: 'unknown' })) };
}

function learned(read: () => SkillListReport): Read<InstalledItem[]> {
  let report: SkillListReport;
  try { report = read(); } catch { return { state: 'unknown' }; }
  if (report.corpus === 'missing') return { state: 'none' };
  if (report.corpus === 'degraded' && report.skills.length === 0) return { state: 'unknown' };
  // Skill retrieval is observe-only today: no lane is handed these cards.
  return { state: 'read', value: report.skills.map(skill => ({ name: skill.name, source: LEARNED_SKILLS_SOURCE, agents: 'No lane yet (observe-only)', enabled: skill.status === 'verified', lastUsed: 'unknown' })) };
}

/** Skills: Claude Code and Codex user skills, and Phantom's learned skill cards. */
export function readSkillsPanel(opts: InstalledPanelOptions = {}): InstalledPanel {
  const home = opts.home ?? homedir();
  return collect('fleet.skills-panel.v1', opts.now?.() ?? new Date(), [
    { source: 'Claude Code', read: skillDirs(join(home, '.claude', 'skills'), 'Claude Code', 'Claude lanes') },
    { source: 'Codex', read: skillDirs(join(home, '.codex', 'skills'), 'Codex', 'Codex lanes') },
    { source: LEARNED_SKILLS_SOURCE, read: learned(opts.learnedSkills ?? (() => listSkills({ limit: SKILL_LIST_MAX_LIMIT }))) },
  ]);
}

const yesNo = (value: boolean | 'unknown') => value === 'unknown' ? 'unknown' : value ? 'on' : 'off';

/** Plain text for the CLI; the same rows the panes show. */
export function formatInstalledPanel(panel: InstalledPanel, noun: string): string {
  const lines = panel.sources.map(s => `${s.source}: ${s.state === 'read' ? `${s.count} ${noun}` : s.state === 'none' ? `no ${noun}` : 'unknown (could not read)'}`);
  for (const item of panel.items) lines.push(`  ${yesNo(item.enabled).padEnd(7)} ${item.name}  [${item.source}]  ${item.agents}  last used: ${item.lastUsed}`);
  return lines.join('\n');
}

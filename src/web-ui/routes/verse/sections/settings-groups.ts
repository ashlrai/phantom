/**
 * routes/verse/sections/settings-groups.ts — the Settings nav: which group
 * each panel lives in, the words search matches, and the selected group.
 *
 * Only the selected group mounts, so opening Settings starts one group's
 * reads instead of every panel's. Search matches these static titles and
 * keywords without mounting anything; a match mounts only that panel.
 */
import { useSyncExternalStore } from 'react';

export type SettingsGroupId = 'general' | 'appearance' | 'accounts' | 'updates' | 'autonomy' | 'team' | 'about';
/** `all` renders every group in order; the "All settings" nav entry. */
export type SettingsView = SettingsGroupId | 'all';

export interface SettingsGroup {
  id: SettingsGroupId;
  label: string;
  description: string;
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: 'general', label: 'General', description: 'Chat defaults, workspace, desktop, quiet hours and keyboard' },
  { id: 'appearance', label: 'Appearance', description: 'Theme, accent, density, layout and the config file' },
  { id: 'accounts', label: 'Accounts & resources', description: 'Connection, connectors, planner logins and the ecosystem' },
  { id: 'updates', label: 'Updates', description: 'Desktop updates, release gap and what is new' },
  { id: 'autonomy', label: 'Autonomy', description: 'Resident awake, build limits and comms limits' },
  { id: 'team', label: 'Team', description: 'Teammates, invites and approvals' },
  { id: 'about', label: 'About', description: 'Version, build, diagnostics and the tour' },
];

export type SettingsPanelId =
  | 'chat' | 'workspace' | 'desktop' | 'quiet-hours' | 'keyboard'
  | 'appearance' | 'layout' | 'config-file'
  | 'connection' | 'connectors' | 'planner-slate' | 'ecosystem' | 'secrets'
  | 'updates' | 'whats-new'
  | 'resident-awake' | 'build-limits' | 'comms-limits'
  | 'team'
  | 'about' | 'onboarding';

export interface SettingsPanelEntry {
  id: SettingsPanelId;
  group: SettingsGroupId;
  title: string;
  keywords: string;
}

/** Order inside a group is render order; the most-used controls come first. */
export const SETTINGS_PANELS: readonly SettingsPanelEntry[] = [
  { id: 'chat', group: 'general', title: 'Chat', keywords: 'reasoning effort mode plan full access new chats defaults' },
  { id: 'workspace', group: 'general', title: 'Workspace', keywords: 'agent workspace one ask feature flag' },
  { id: 'desktop', group: 'general', title: 'Desktop', keywords: 'system-wide shortcut hotkey notifications dock layout fleet workspace' },
  { id: 'quiet-hours', group: 'general', title: 'Quiet hours', keywords: 'do not disturb night schedule' },
  { id: 'keyboard', group: 'general', title: 'Keyboard', keywords: 'shortcuts keys bindings' },
  { id: 'appearance', group: 'appearance', title: 'Appearance', keywords: 'theme dark light accent color hue density display size font radius motion sidebar mark' },
  { id: 'layout', group: 'appearance', title: 'Layout', keywords: 'sidebar resources width panes' },
  { id: 'config-file', group: 'appearance', title: 'Config file', keywords: 'ui.json reload edit' },
  { id: 'connection', group: 'accounts', title: 'Connection', keywords: 'server token unlock disconnect pairing phone fleet on this mac runs devices' },
  { id: 'connectors', group: 'accounts', title: 'Connectors', keywords: 'mcp integrations github slack' },
  { id: 'planner-slate', group: 'accounts', title: 'Planner logins', keywords: 'planner slate leader accounts' },
  { id: 'ecosystem', group: 'accounts', title: 'Connect your ecosystem', keywords: 'phantom secrets locus lexicon stack capabilities grant onboarding' },
  { id: 'secrets', group: 'accounts', title: 'Phantom Secrets', keywords: 'vault custody credentials' },
  { id: 'updates', group: 'updates', title: 'Updates', keywords: 'update now automatic updates version release gap check refresh install' },
  { id: 'whats-new', group: 'updates', title: "What's new", keywords: 'release notes changelog' },
  { id: 'resident-awake', group: 'autonomy', title: 'Resident awake', keywords: 'sleep caffeinate coffee daemon resident' },
  { id: 'build-limits', group: 'autonomy', title: 'Build limits', keywords: 'stale build limits' },
  { id: 'comms-limits', group: 'autonomy', title: 'Comms limits', keywords: 'messages owner thread rate limits' },
  { id: 'team', group: 'team', title: 'Team', keywords: 'teammates invite members approvals handoffs github username' },
  { id: 'about', group: 'about', title: 'About', keywords: 'version build diagnostics source self-update commit' },
  { id: 'onboarding', group: 'about', title: 'Onboarding', keywords: 'tour first-run replay how phantom works verified result' },
];

/** Shell anchors that live inside a group (setVerseSection('settings', anchor)). */
export const SETTINGS_ANCHOR_GROUPS: Readonly<Record<string, SettingsGroupId>> = {
  'fleet-sources': 'accounts',
  'desktop-updates': 'updates',
};

export const SETTINGS_GROUP_STORAGE_KEY = 'ashlr.verse.settings.group';
const VIEWS = new Set<string>(['all', ...SETTINGS_GROUPS.map((group) => group.id)]);

function readStored(): SettingsView {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(SETTINGS_GROUP_STORAGE_KEY);
    return raw && VIEWS.has(raw) ? (raw as SettingsView) : 'general';
  } catch {
    return 'general';
  }
}

let current: SettingsView | null = null;
const listeners = new Set<() => void>();

export function getSettingsView(): SettingsView {
  if (current === null) current = readStored();
  return current;
}

export function setSettingsView(view: SettingsView): void {
  if (!VIEWS.has(view) || view === getSettingsView()) return;
  current = view;
  try { localStorage.setItem(SETTINGS_GROUP_STORAGE_KEY, view); } catch { /* storage is optional */ }
  for (const listener of listeners) listener();
}

/** Forget the in-memory selection (tests; a cleared localStorage). */
export function resetSettingsView(): void {
  current = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSettingsView(): SettingsView {
  return useSyncExternalStore(subscribe, getSettingsView, () => 'general');
}

/** Panels a search shows, in registry order. Every word must match. */
export function searchSettings(query: string): SettingsPanelEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return SETTINGS_PANELS.filter((panel) => {
    const group = SETTINGS_GROUPS.find((g) => g.id === panel.group)!;
    const haystack = `${panel.title} ${panel.keywords} ${group.label}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function panelsInGroup(group: SettingsGroupId): SettingsPanelEntry[] {
  return SETTINGS_PANELS.filter((panel) => panel.group === group);
}

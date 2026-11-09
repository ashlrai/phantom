/**
 * desktop operator policy. Reuses the computer-use denylist, settings titles
 * and bundle matcher from computer-types.ts, and the Devin/Claude/Codex
 * identities from desktop-adapters.ts. Two owner exceptions sit on top of
 * that policy: Phantom itself (`ai.ashlr.desktop`) may be operated, and
 * Cursor may be typed into. The computer_* grant path is unchanged.
 *
 * Screen Recording and Accessibility URLs match computer.rs
 * SETTINGS_URL_SCREEN and SETTINGS_URL_ACCESSIBILITY.
 */
import {
  COMPUTER_DENIED_EXECUTABLE_PREFIXES,
  COMPUTER_DENIED_SETTINGS_TITLES,
  SYSTEM_SETTINGS_BUNDLES,
  bundleMatches,
  computerAppPolicy,
  isDeniedSettingsTitle,
} from '../verse/computer-types.js';
import { DESKTOP_APP_PROFILES, MAX_COLLECT_CHARS, MAX_TASK_CHARS } from '../verse/desktop-adapters.js';
import { scrubSecrets } from '../util/scrub.js';

export const DESKTOP_OPERATOR_BINARY = 'desktop-operator';

export const ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
export const SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

export const ACCESSIBILITY_PANE = 'System Settings > Privacy & Security > Accessibility';
export const SCREEN_RECORDING_PANE = 'System Settings > Privacy & Security > Screen & System Audio Recording';
export const SCREEN_RECORDING_LEGACY_PANE = 'Screen Recording';

export const DESKTOP_OPERATOR_BUILD =
  'swiftc -O -framework ApplicationServices -framework Cocoa -framework Vision -o ~/.ashlr/bin/desktop-operator tools/desktop-operator/main.swift';

/** Matches computer.rs MAX_SCROLL. */
export const MAX_SCROLL = 50;

export const DESKTOP_READ_VERBS = ['list-apps', 'windows', 'read', 'screenshot', 'doctor'] as const;
export const DESKTOP_WRITE_VERBS = ['focus', 'scroll', 'type', 'click'] as const;
export type DesktopReadVerb = (typeof DESKTOP_READ_VERBS)[number];
export type DesktopWriteVerb = (typeof DESKTOP_WRITE_VERBS)[number];
export type OperatorVerb = DesktopReadVerb | DesktopWriteVerb;

export function isWriteVerb(verb: OperatorVerb): verb is DesktopWriteVerb {
  return (DESKTOP_WRITE_VERBS as readonly string[]).includes(verb);
}

export interface PermissionPane {
  permission: 'accessibility' | 'screen_recording';
  pane: string;
  legacyPane?: string;
  settingsUrl: string;
  binary: string;
}

export const ACCESSIBILITY_PERMISSION: PermissionPane = {
  permission: 'accessibility',
  pane: ACCESSIBILITY_PANE,
  settingsUrl: ACCESSIBILITY_SETTINGS_URL,
  binary: DESKTOP_OPERATOR_BINARY,
};

export const SCREEN_RECORDING_PERMISSION: PermissionPane = {
  permission: 'screen_recording',
  pane: SCREEN_RECORDING_PANE,
  legacyPane: SCREEN_RECORDING_LEGACY_PANE,
  settingsUrl: SCREEN_RECORDING_SETTINGS_URL,
  binary: DESKTOP_OPERATOR_BINARY,
};

export interface OperatorRosterApp {
  id: 'phantom' | 'devin' | 'codex' | 'claude' | 'grok' | 'cursor';
  names: readonly string[];
  bundleIds: readonly string[];
}

/** Visible sessions the unified roster can show once Accessibility is granted. */
export const OPERATOR_ROSTER: readonly OperatorRosterApp[] = [
  { id: 'phantom', names: ['Phantom', 'Ashlr'], bundleIds: ['ai.ashlr.desktop'] },
  { id: 'devin', names: DESKTOP_APP_PROFILES.devin.names, bundleIds: DESKTOP_APP_PROFILES.devin.bundleIds },
  { id: 'codex', names: DESKTOP_APP_PROFILES.codex.names, bundleIds: DESKTOP_APP_PROFILES.codex.bundleIds },
  { id: 'claude', names: DESKTOP_APP_PROFILES.claude.names, bundleIds: DESKTOP_APP_PROFILES.claude.bundleIds },
  { id: 'grok', names: ['Grok', 'Grok Bot'], bundleIds: ['ai.x.grok', 'com.xai.grok'] },
  { id: 'cursor', names: ['Cursor'], bundleIds: ['com.todesktop.230313mzl4w4u92'] },
];

const MESSAGES_BUNDLES = ['com.apple.MobileSMS', 'com.apple.iChat'] as const;
const DENIED_NAMES = new Set(['messages', 'keychain access', 'passwords', 'system settings']);

const FORBIDDEN_STORE = /chat\.db|login\.keychain|\/keychains?\/|library\/messages|cookies\.binarycookies/i;

export function forbiddenStoreText(value: string | null | undefined): boolean {
  return typeof value === 'string' && FORBIDDEN_STORE.test(value);
}

export function rosterAppId(name: string, bundleId: string | null): OperatorRosterApp['id'] | null {
  const needle = name.trim().toLowerCase();
  for (const app of OPERATOR_ROSTER) {
    if (bundleId && app.bundleIds.some((id) => bundleMatches(id, bundleId))) return app.id;
    if (app.names.some((entry) => entry.toLowerCase() === needle)) return app.id;
  }
  return null;
}

function isCursor(name: string, bundleId: string | null): boolean {
  if (bundleId && bundleMatches('com.todesktop.230313mzl4w4u92', bundleId)) return true;
  return name.trim().toLowerCase() === 'cursor';
}

function isPhantom(name: string, bundleId: string | null): boolean {
  if (bundleId && bundleMatches('ai.ashlr.desktop', bundleId)) return true;
  const needle = name.trim().toLowerCase();
  return needle === 'phantom' || needle === 'ashlr';
}

/**
 * Null means the verb may run. A string is the refusal the caller returns
 * under code `denied`.
 */
export function operatorDenyReason(input: {
  name: string;
  bundleId: string | null;
  executablePath?: string | null;
  windowTitle?: string | null;
  verb: OperatorVerb;
}): string | null {
  const name = input.name.trim();
  const bundleId = input.bundleId;
  if (input.executablePath && COMPUTER_DENIED_EXECUTABLE_PREFIXES.some((prefix) => input.executablePath!.startsWith(prefix))) {
    return 'The Phantom custody helper is closed to desktop control.';
  }
  if (input.windowTitle && isDeniedSettingsTitle(input.windowTitle)) {
    return 'System Settings privacy panes are closed to desktop control.';
  }
  if (DENIED_NAMES.has(name.toLowerCase())) {
    return `${name} is closed to desktop control.`;
  }
  if (bundleId && MESSAGES_BUNDLES.some((id) => bundleMatches(id, bundleId))) {
    return 'Messages is closed to desktop control.';
  }
  if (bundleId && SYSTEM_SETTINGS_BUNDLES.some((id) => bundleMatches(id, bundleId))) {
    return 'System Settings is closed to desktop control.';
  }
  if (isPhantom(name, bundleId)) return null;
  if (bundleId) {
    const policy = computerAppPolicy(bundleId, input.executablePath);
    if (policy.ceiling === null) return policy.reason;
    if (isWriteVerb(input.verb) && policy.category === 'browser') return policy.reason;
    if (input.verb === 'type' && policy.category === 'terminal-ide' && !isCursor(name, bundleId)) return policy.reason;
    return null;
  }
  if (rosterAppId(name, null)) return null;
  return 'This process has no app identity.';
}

export function busField(value: string | null | undefined, max = 160): string | null {
  if (!value) return null;
  const clean = scrubSecrets(value.replace(/\p{Cc}/gu, ' ')).slice(0, max);
  return clean.length > 0 ? clean : null;
}

export function clampText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_COLLECT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_COLLECT_CHARS), truncated: true };
}

export { COMPUTER_DENIED_SETTINGS_TITLES, MAX_COLLECT_CHARS, MAX_TASK_CHARS };

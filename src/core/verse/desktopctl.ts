/**
 * core/verse/desktopctl.ts — `phm desktopctl` core (RQ-SWE2-DESKTOPCTL-1):
 * the Claude, Codex and Devin desktop apps — plus a browser — as
 * interchangeable desktop resources an agent can drive through the
 * `computer_*` tools, with explicit permission checks and graceful
 * degradation when macOS TCC grants are missing.
 *
 * NOTHING HERE TOUCHES THE DESKTOP DIRECTLY. Every step is a `computer_*`
 * call through an injected `ToolCall`, exactly like the task adapters in
 * desktop-adapters.ts: the operator's per-chat grant, tier ceilings, the
 * confirmation card, the denylist, takeover and KILL all stay in force. The
 * permission check is the `computer_permissions` tool — a read-only TCC
 * preflight that never shows a prompt; granting is the operator's alone.
 *
 * FEATURE FLAG. Everything is off until `~/.ashlr/desktopctl.json` holds
 * `{ "enabled": true }`. The file may also pin bundle ids for beta channels:
 * `{ "enabled": true, "bundleIds": { "claude": "com.anthropic.claude.beta" } }`.
 * A missing file disables; a malformed file fails closed (disabled, with the
 * parse error reported).
 */
import { readFileSync } from 'node:fs';

import {
  createBrowserDesktopAdapter,
  createDesktopAdapters,
  DESKTOP_APP_PROFILES,
  parseRunningApps,
  runningBrowserApp,
  type DesktopAdapter,
  type DesktopAppId,
  type RunningApp,
  type ToolCall,
} from './desktop-adapters.js';
import { computerAppPolicy, type ComputerTier } from './computer-types.js';
import { COMPUTER_PERMISSIONS_LINE_PREFIX, type ComputerPermissionState } from './verse-mcp-computer.js';

// ---------------------------------------------------------------------------
// The feature flag
// ---------------------------------------------------------------------------

export interface DesktopctlFlag {
  enabled: boolean;
  /** Bundle id overrides per task resource (beta channels). */
  bundleIds: Partial<Record<DesktopAppId, string>>;
}

export const DESKTOPCTL_FLAG_OFF: DesktopctlFlag = { enabled: false, bundleIds: {} };

export type DesktopctlFlagRead =
  | { ok: true; flag: DesktopctlFlag }
  | { ok: false; flag: DesktopctlFlag; error: string };

const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const TASK_RESOURCE_IDS: readonly DesktopAppId[] = ['claude', 'codex', 'devin'];

function flagError(error: string): DesktopctlFlagRead {
  return { ok: false, flag: DESKTOPCTL_FLAG_OFF, error };
}

/** Strict parse: unknown keys, a non-boolean `enabled` or a bad override fail closed. */
export function parseDesktopctlFlag(text: string): DesktopctlFlagRead {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return flagError('desktopctl.json is not valid JSON.'); }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return flagError('desktopctl.json must be a JSON object.');
  const rec = json as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (key !== 'enabled' && key !== 'bundleIds') return flagError(`desktopctl.json has an unknown key "${key.slice(0, 40)}".`);
  }
  if (typeof rec['enabled'] !== 'boolean') return flagError('desktopctl.json needs "enabled": true or false.');
  const bundleIds: Partial<Record<DesktopAppId, string>> = {};
  if (rec['bundleIds'] !== undefined) {
    if (typeof rec['bundleIds'] !== 'object' || rec['bundleIds'] === null || Array.isArray(rec['bundleIds'])) {
      return flagError('desktopctl.json "bundleIds" must be an object like { "claude": "com.example.app" }.');
    }
    for (const [key, value] of Object.entries(rec['bundleIds'] as Record<string, unknown>)) {
      if (!TASK_RESOURCE_IDS.includes(key as DesktopAppId)) return flagError(`desktopctl.json has no resource named "${key.slice(0, 40)}".`);
      if (typeof value !== 'string' || !BUNDLE_ID.test(value)) return flagError(`desktopctl.json bundle id for "${key}" is not a bundle id.`);
      bundleIds[key as DesktopAppId] = value;
    }
  }
  return { ok: true, flag: { enabled: rec['enabled'], bundleIds } };
}

/** A missing file is the flag off; another read failure fails closed too. */
export function readDesktopctlFlag(path: string): DesktopctlFlagRead {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, flag: DESKTOPCTL_FLAG_OFF };
    return flagError('desktopctl.json could not be read.');
  }
  return parseDesktopctlFlag(text);
}

// ---------------------------------------------------------------------------
// Permission state (parsed out of the computer_permissions answer)
// ---------------------------------------------------------------------------

export interface DesktopPermissions {
  /** The host answered with a readable report (connected + tool present). */
  checked: boolean;
  supported: boolean | null;
  macos: string | null;
  screen: ComputerPermissionState;
  accessibility: ComputerPermissionState;
  postEvents: ComputerPermissionState;
  /** Why the check could not run (tool error, unreadable answer). */
  detail: string | null;
}

export const UNKNOWN_DESKTOP_PERMISSIONS: DesktopPermissions = {
  checked: false, supported: null, macos: null,
  screen: 'unknown', accessibility: 'unknown', postEvents: 'unknown', detail: null,
};

const PERMISSION_STATES: ReadonlySet<string> = new Set(['granted', 'missing', 'unknown']);

/** The `desktop-permissions:` machine line → a report, or null when absent. */
export function parseDesktopPermissionsText(text: string): Omit<DesktopPermissions, 'checked' | 'detail'> | null {
  const line = text.split('\n').find((l) => l.startsWith(COMPUTER_PERMISSIONS_LINE_PREFIX));
  if (!line) return null;
  const pairs = new Map<string, string>();
  for (const token of line.slice(COMPUTER_PERMISSIONS_LINE_PREFIX.length).trim().split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq > 0) pairs.set(token.slice(0, eq), token.slice(eq + 1));
  }
  const state = (key: string): ComputerPermissionState => {
    const value = pairs.get(key);
    return value !== undefined && PERMISSION_STATES.has(value) ? (value as ComputerPermissionState) : 'unknown';
  };
  const supported = pairs.get('supported');
  const macos = pairs.get('macos');
  return {
    supported: supported === 'true' ? true : supported === 'false' ? false : null,
    macos: macos !== undefined && macos !== '-' && /^[0-9]+(\.[0-9]+){0,3}$/.test(macos) ? macos : null,
    screen: state('screen'),
    accessibility: state('accessibility'),
    postEvents: state('postEvents'),
  };
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.flatMap((c) => (c.type === 'text' && typeof c.text === 'string' ? [c.text] : [])).join('\n');
}

/** Run the read-only permission preflight through the desktop connection. */
export async function probeDesktopPermissions(call: ToolCall): Promise<DesktopPermissions> {
  const res = await call('computer_permissions', {});
  if (res.isError) {
    return { ...UNKNOWN_DESKTOP_PERMISSIONS, detail: toolText(res).slice(0, 200) || 'the permission check failed.' };
  }
  const parsed = parseDesktopPermissionsText(toolText(res));
  if (!parsed) return { ...UNKNOWN_DESKTOP_PERMISSIONS, detail: 'the desktop returned an unreadable permission report.' };
  return { ...parsed, checked: true, detail: null };
}

// ---------------------------------------------------------------------------
// Resources and capabilities
// ---------------------------------------------------------------------------

export type DesktopResourceId = DesktopAppId | 'browser';
export type DesktopResourceKind = 'task' | 'read';
export const DESKTOP_RESOURCE_IDS: readonly DesktopResourceId[] = ['claude', 'codex', 'devin', 'browser'];

export function isDesktopResourceId(value: string): value is DesktopResourceId {
  return (DESKTOP_RESOURCE_IDS as readonly string[]).includes(value);
}

export interface DesktopResourceCapability {
  id: DesktopResourceId;
  kind: DesktopResourceKind;
  /** The running app this resource resolved to (null: not running / not listed). */
  name: string | null;
  bundleId: string | null;
  running: boolean | null;
  frontmost: boolean | null;
  /** The tier this chat already holds (null: none yet — `run` will ask the operator). */
  heldTier: ComputerTier | null;
  /** The highest tier this app can ever be granted (null: never). */
  ceiling: ComputerTier | null;
  can: { status: boolean; read: boolean; run: boolean };
  /** Machine codes for what blocks the resource, worst first. */
  reasons: string[];
}

export interface DesktopctlCapabilities {
  flagEnabled: boolean;
  flagError: string | null;
  connected: boolean;
  /** Why the desktop connection could not be used (the list-apps error). */
  connectionDetail: string | null;
  permissions: DesktopPermissions;
  resources: DesktopResourceCapability[];
}

function matchTaskResource(id: DesktopAppId, bundleOverride: string | undefined, apps: readonly RunningApp[]): RunningApp | null {
  if (bundleOverride) {
    const hit = apps.find((a) => a.bundleId?.toLowerCase() === bundleOverride.toLowerCase());
    if (hit) return hit;
  }
  const { names, bundleIds } = DESKTOP_APP_PROFILES[id];
  return apps.find((a) =>
    (a.bundleId && bundleIds.some((b) => b.toLowerCase() === a.bundleId!.toLowerCase()))
    || names.some((n) => n.toLowerCase() === a.name.toLowerCase())) ?? null;
}

function resourceReasons(input: {
  kind: DesktopResourceKind;
  connected: boolean;
  flagEnabled: boolean;
  running: boolean | null;
  bundleId: string | null;
  ceiling: ComputerTier | null;
  heldTier: ComputerTier | null;
  accessibility: ComputerPermissionState;
  postEvents: ComputerPermissionState;
}): { can: DesktopResourceCapability['can']; reasons: string[] } {
  const reasons: string[] = [];
  const can = { status: false, read: false, run: false };
  if (!input.connected) { reasons.push('not-connected'); return { can, reasons }; }
  if (!input.flagEnabled) { reasons.push('flag-off'); return { can, reasons }; }
  if (input.running !== true) { reasons.push(input.running === null ? 'unknown' : 'not-running'); return { can, reasons }; }
  if (!input.bundleId) { reasons.push('no-bundle-id'); return { can, reasons }; }
  if (input.ceiling === null) { reasons.push('never-available'); return { can, reasons }; }
  if (input.accessibility === 'missing') { reasons.push('permission:accessibility'); return { can, reasons }; }
  // Reading (status, collect) needs an existing grant: neither verb asks for one.
  const granted = input.heldTier !== null;
  if (!granted) reasons.push('not-granted');
  can.status = granted;
  can.read = granted;
  if (input.kind === 'task') {
    // The drive flow presses controls and types: it needs input events and,
    // when a grant is already held, the full tier. No grant yet is fine —
    // `run` asks the operator at the app's ceiling.
    if (input.postEvents === 'missing') reasons.push('permission:post-events');
    else if (input.ceiling !== 'full') reasons.push('ceiling:insufficient');
    else if (granted && input.heldTier !== 'full') reasons.push('tier:insufficient');
    else can.run = true;
  } else {
    reasons.push('read-only-resource');
  }
  return { can, reasons };
}

export interface ProbeCapabilitiesOptions {
  flag?: DesktopctlFlag;
  flagError?: string | null;
  /** The probe still runs when false; `run` answers are just not attempted. Pass false only from tests. */
  checkPermissions?: boolean;
}

/**
 * One pass over the desktop connection: is it there, which TCC grants the
 * host reports, and what each interchangeable resource can do right now.
 * A resource that cannot act says exactly why (`reasons`) — that is the
 * graceful degradation contract.
 */
export async function probeDesktopCapabilities(call: ToolCall, opts: ProbeCapabilitiesOptions = {}): Promise<DesktopctlCapabilities> {
  const flag = opts.flag ?? DESKTOPCTL_FLAG_OFF;
  const listed = await call('computer_list_apps', {});
  const connected = !listed.isError;
  const apps = connected ? parseRunningApps(toolText(listed)) : [];
  const permissions = connected && (opts.checkPermissions ?? true)
    ? await probeDesktopPermissions(call)
    : UNKNOWN_DESKTOP_PERMISSIONS;
  const resources: DesktopResourceCapability[] = [];
  for (const id of DESKTOP_RESOURCE_IDS) {
    const kind: DesktopResourceKind = id === 'browser' ? 'read' : 'task';
    const app = !connected ? null
      : id === 'browser'
        ? (runningBrowserApp(apps) ?? apps.find((a) => a.bundleId && computerAppPolicy(a.bundleId).category === 'browser') ?? null)
        : matchTaskResource(id, flag.bundleIds[id], apps);
    const running = connected ? app !== null : null;
    const bundleId = id === 'browser' ? app?.bundleId ?? null : flag.bundleIds[id] ?? app?.bundleId ?? null;
    const ceiling = bundleId ? computerAppPolicy(bundleId).ceiling : 'full';
    const heldTier = app?.heldTier ?? null;
    const { can, reasons } = resourceReasons({
      kind, connected, flagEnabled: flag.enabled, running, bundleId,
      ceiling: bundleId ? ceiling : 'full',
      heldTier,
      accessibility: permissions.accessibility,
      postEvents: permissions.postEvents,
    });
    resources.push({
      id, kind,
      name: app?.name ?? null, bundleId,
      running, frontmost: app?.frontmost ?? (running === false ? false : null),
      heldTier, ceiling: bundleId ? ceiling : null,
      can, reasons,
    });
  }
  return {
    flagEnabled: flag.enabled,
    flagError: opts.flagError ?? null,
    connected,
    connectionDetail: connected ? null : toolText(listed).slice(0, 200) || 'no desktop connection.',
    permissions,
    resources,
  };
}

/** The adapters for every resource, interchangeable by id. */
export function createDesktopctlAdapters(call: ToolCall, flag: DesktopctlFlag = DESKTOPCTL_FLAG_OFF): Record<DesktopResourceId, DesktopAdapter> {
  return {
    ...createDesktopAdapters(call, {
      claude: flag.bundleIds.claude ? { bundleId: flag.bundleIds.claude } : {},
      codex: flag.bundleIds.codex ? { bundleId: flag.bundleIds.codex } : {},
      devin: flag.bundleIds.devin ? { bundleId: flag.bundleIds.devin } : {},
    }),
    browser: createBrowserDesktopAdapter(call),
  };
}

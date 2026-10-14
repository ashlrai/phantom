/**
 * Phantom settings (`ashlr settings`, MCP `ashlr_settings_get|set`, console
 * Settings page). One typed view + one validated change path for every surface.
 *
 * SAFETY: every change is classified `narrowing` (less authority, spend or
 * reach) or `widening`. Agents (MCP) may apply narrowing changes only; a
 * widening change from MCP is returned as `needs-human` with the exact CLI
 * command. Raising the autonomy switch is additionally capped by the signed
 * grant (requestAutonomySwitch). Constitution edits are versioned and can be
 * reverted; agents can read versions but never write the constitution.
 */
export type AutonomyLevel = 'off' | 'propose' | 'autonomous';
const RANK: Record<AutonomyLevel, number> = { off: 0, propose: 1, autonomous: 2 };

export interface SettingsV1 {
  schemaVersion: 1;
  kind: 'ashlr-settings';
  autonomy: { level: AutonomyLevel; grantActive: boolean; maxLevel: AutonomyLevel };
  repos: { enrolled: string[] };
  schedules: { id: string; name: string; enabled: boolean }[];
  models: { allowedEngines: string[] | null };
  budget: { dailyUsd: number; perItemMaxTokens: number | null; maxConcurrent: number | null };
  notifications: { desktop: boolean; proactive: boolean; slack: boolean; discord: boolean };
  constitution: { path: string | null; versions: { id: string; at: string; bytes: number; note: string }[] };
}

export type SettingsChange =
  | { key: 'autonomy.level'; value: AutonomyLevel }
  | { key: 'repos.enroll' | 'repos.unenroll'; value: string }
  | { key: 'schedules.enable' | 'schedules.disable'; value: string }
  | { key: 'models.allowedEngines'; value: string[] }
  | { key: 'budget.dailyUsd'; value: number }
  | { key: 'budget.perItemMaxTokens'; value: number }
  | { key: 'budget.maxConcurrent'; value: number }
  | { key: 'notifications.desktop' | 'notifications.proactive'; value: boolean }
  | { key: 'constitution.save'; value: { text: string; note?: string } }
  | { key: 'constitution.revert'; value: string };

export const SETTINGS_KEYS = ['autonomy.level', 'repos.enroll', 'repos.unenroll', 'schedules.enable', 'schedules.disable', 'models.allowedEngines', 'budget.dailyUsd', 'budget.perItemMaxTokens', 'budget.maxConcurrent', 'notifications.desktop', 'notifications.proactive', 'constitution.save', 'constitution.revert'] as const;

export interface SettingsResult {
  ok: boolean;
  status: 'applied' | 'unchanged' | 'needs-human' | 'refused' | 'invalid';
  direction: 'narrowing' | 'widening';
  detail: string;
  command?: string;
  settings?: SettingsV1;
}

export interface SettingsBackend {
  read(): Promise<SettingsV1>;
  apply(change: SettingsChange): Promise<{ ok: boolean; detail: string }>;
}

/** PURE: validate an untrusted `{key, value}`; returns the typed change or an actionable error. */
export function parseSettingsChange(raw: unknown): { ok: true; change: SettingsChange } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'expected {key, value}' };
  const { key, value } = raw as { key?: unknown; value?: unknown };
  if (typeof key !== 'string' || !(SETTINGS_KEYS as readonly string[]).includes(key)) return { ok: false, error: `key must be one of: ${SETTINGS_KEYS.join(', ')}` };
  const bad = (why: string) => ({ ok: false as const, error: `${key}: ${why}` });
  switch (key) {
    case 'autonomy.level': return value === 'off' || value === 'propose' || value === 'autonomous' ? { ok: true, change: { key, value } } : bad('must be off, propose or autonomous');
    case 'repos.enroll': case 'repos.unenroll': case 'schedules.enable': case 'schedules.disable': case 'constitution.revert':
      return typeof value === 'string' && value.trim() ? { ok: true, change: { key, value: value.trim() } as SettingsChange } : bad('needs a non-empty string');
    case 'models.allowedEngines': return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && /^[a-z0-9:_-]{1,40}$/i.test(v)) ? { ok: true, change: { key, value: value as string[] } } : bad('needs a non-empty list of engine ids');
    case 'budget.dailyUsd': return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000 ? { ok: true, change: { key, value } } : bad('must be a number from 0 to 1000');
    case 'budget.perItemMaxTokens': return Number.isInteger(value) && (value as number) >= 1000 && (value as number) <= 10_000_000 ? { ok: true, change: { key, value: value as number } } : bad('must be a whole number from 1000 to 10000000');
    case 'budget.maxConcurrent': return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 64 ? { ok: true, change: { key, value: value as number } } : bad('must be a whole number from 0 to 64');
    case 'notifications.desktop': case 'notifications.proactive': return typeof value === 'boolean' ? { ok: true, change: { key, value } as SettingsChange } : bad('must be true or false');
    case 'constitution.save': {
      const v = value as { text?: unknown; note?: unknown } | null;
      return v && typeof v.text === 'string' && v.text.length > 0 && v.text.length <= 200_000 ? { ok: true, change: { key, value: { text: v.text, ...(typeof v.note === 'string' ? { note: v.note.slice(0, 200) } : {}) } } } : bad('needs {text} up to 200 KB');
    }
  }
  return { ok: false, error: 'unreachable' };
}

/** PURE: does this change reduce authority, spend or reach? */
export function changeDirection(change: SettingsChange, current: SettingsV1): 'narrowing' | 'widening' {
  switch (change.key) {
    case 'autonomy.level': return RANK[change.value] <= RANK[current.autonomy.level] ? 'narrowing' : 'widening';
    case 'repos.unenroll': case 'schedules.disable': return 'narrowing';
    case 'repos.enroll': case 'schedules.enable': return 'widening';
    case 'models.allowedEngines': return current.models.allowedEngines !== null && change.value.every((e) => current.models.allowedEngines!.includes(e)) ? 'narrowing' : 'widening';
    case 'budget.dailyUsd': return change.value <= current.budget.dailyUsd ? 'narrowing' : 'widening';
    case 'budget.perItemMaxTokens': return current.budget.perItemMaxTokens !== null && change.value <= current.budget.perItemMaxTokens ? 'narrowing' : 'widening';
    case 'budget.maxConcurrent': return current.budget.maxConcurrent !== null && change.value <= current.budget.maxConcurrent ? 'narrowing' : 'widening';
    case 'notifications.desktop': case 'notifications.proactive': return 'narrowing'; // local, outbound to the human only
    case 'constitution.save': case 'constitution.revert': return 'widening'; // the agents' own rules
  }
}

/** The exact CLI a human runs for a change. */
export function settingsCommand(change: SettingsChange): string {
  if (change.key === 'constitution.save') return 'ashlr settings set constitution.save --file <AGENTS.md>';
  const v = change.value as unknown;
  return `ashlr settings set ${change.key} ${Array.isArray(v) ? v.join(',') : String(v)}`;
}

export async function applySettingsChange(backend: SettingsBackend, raw: unknown, actor: 'human' | 'agent'): Promise<SettingsResult> {
  const parsed = parseSettingsChange(raw);
  if (!parsed.ok) return { ok: false, status: 'invalid', direction: 'widening', detail: parsed.error, command: 'ashlr settings --json' };
  const current = await backend.read();
  const direction = changeDirection(parsed.change, current);
  if (parsed.change.key === 'autonomy.level' && RANK[parsed.change.value] > RANK[current.autonomy.maxLevel]) {
    return { ok: false, status: 'refused', direction, detail: `the standing grant caps autonomy at ${current.autonomy.maxLevel}`, command: 'ashlr ecosystem up' };
  }
  if (actor === 'agent' && direction === 'widening') {
    return { ok: false, status: 'needs-human', direction, detail: `${parsed.change.key} widens authority, spend or the agents' own rules; a human must make it`, command: settingsCommand(parsed.change) };
  }
  const r = await backend.apply(parsed.change);
  return r.ok
    ? { ok: true, status: r.detail === 'unchanged' ? 'unchanged' : 'applied', direction, detail: r.detail, settings: await backend.read() }
    : { ok: false, status: 'refused', direction, detail: r.detail, command: settingsCommand(parsed.change) };
}

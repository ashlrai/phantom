/**
 * `ashlr settings [--json]` and `ashlr settings set <key> <value> [--json]`.
 * Core: src/core/settings/settings.ts (shared with MCP `ashlr_settings_*` and the console Settings page).
 */
import { readFileSync } from 'node:fs';
import { applySettingsChange, SETTINGS_KEYS, type SettingsBackend, type SettingsV1 } from '../core/settings/settings.js';
import { isTty, makeColors } from './ui.js';

export const SETTINGS_USAGE = [
  'Usage: ashlr settings [--json]',
  '       ashlr settings set <key> <value> [--json]',
  '       ashlr settings set constitution.save --file <AGENTS.md> [--note "why"]',
  '',
  `  keys: ${SETTINGS_KEYS.join(', ')}`,
].join('\n');

/** PURE: CLI string → typed value for a key. */
export function cliValue(key: string, raw: string): unknown {
  if (key === 'models.allowedEngines') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (key.startsWith('budget.')) return Number(raw);
  if (key.endsWith('Webhook')) return raw === '""' || raw === 'none' || raw === 'off' ? '' : raw;
  if (key.startsWith('notifications.')) return raw === 'true' || raw === 'on' ? true : raw === 'false' || raw === 'off' ? false : raw;
  return raw;
}

export function renderSettings(s: SettingsV1, tty = isTty()): string {
  const { bold, dim } = makeColors(tty);
  return ['',
    `  ${bold('Autonomy')}       ${s.autonomy.level} ${dim(`(grant ${s.autonomy.grantActive ? 'active' : 'none'}; max ${s.autonomy.maxLevel})`)}`,
    `  ${bold('Repos')}          ${s.repos.enrolled.length ? s.repos.enrolled.join(', ') : dim('none enrolled — ashlr ecosystem up')}`,
    `  ${bold('Schedules')}      ${s.schedules.length ? s.schedules.map((a) => `${a.name} ${a.enabled ? 'on' : 'off'}`).join(' · ') : dim('none — ashlr ecosystem up')}`,
    `  ${bold('Models')}         ${s.models.allowedEngines?.join(', ') ?? dim('all configured engines')}`,
    `  ${bold('Budget')}         $${s.budget.dailyUsd}/day · ${s.budget.perItemMaxTokens ?? '—'} tokens/item · ${s.budget.maxConcurrent ?? '—'} concurrent`,
    `  ${bold('Notifications')}  desktop ${s.notifications.desktop ? 'on' : 'off'} · proactive ${s.notifications.proactive ? 'on' : 'off'} · slack ${s.notifications.slack ? 'set' : 'unset'} · discord ${s.notifications.discord ? 'set' : 'unset'}`,
    `  ${bold('Constitution')}   ${s.constitution.path ?? dim('no AGENTS.md found (set $ASHLR_CONSTITUTION)')} ${dim(`· ${s.constitution.versions.length} versions`)}`,
    ''].join('\n');
}

export async function cmdSettings(args: string[], backend?: SettingsBackend): Promise<number> {
  const json = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  if (rest[0] === '--help' || rest[0] === '-h' || rest[0] === 'help') { process.stdout.write(`${SETTINGS_USAGE}\n`); return 0; }
  const be = backend ?? await (await import('../core/settings/backend.js')).realSettingsBackend('cli');
  if (rest.length === 0) {
    const s = await be.read();
    process.stdout.write(json ? `${JSON.stringify(s, null, 2)}\n` : renderSettings(s));
    return 0;
  }
  if (rest[0] !== 'set' || !rest[1]) { process.stderr.write(`${SETTINGS_USAGE}\n`); return 2; }
  const key = rest[1];
  let value: unknown;
  if (key === 'constitution.save') {
    const fi = rest.indexOf('--file'); const ni = rest.indexOf('--note');
    if (fi < 0 || !rest[fi + 1]) { process.stderr.write('constitution.save needs --file <path>\n'); return 2; }
    value = { text: readFileSync(rest[fi + 1]!, 'utf8'), ...(ni >= 0 && rest[ni + 1] ? { note: rest[ni + 1] } : {}) };
  } else {
    if (rest[2] === undefined) { process.stderr.write(`${key} needs a value\n${SETTINGS_USAGE}\n`); return 2; }
    value = cliValue(key, rest[2]);
  }
  const r = await applySettingsChange(be, { key, value }, 'human');
  if (json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else process.stdout.write(`${r.ok ? '✓' : '✗'} ${r.detail}${r.command && !r.ok ? `\n  → ${r.command}` : ''}\n`);
  return r.ok ? 0 : r.status === 'invalid' ? 2 : 1;
}

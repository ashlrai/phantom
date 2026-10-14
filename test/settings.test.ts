import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySettingsChange, parseSettingsChange, type SettingsBackend, type SettingsChange, type SettingsV1 } from '../src/core/settings/settings.js';
import { listVersions, revertConstitution, saveConstitution } from '../src/core/settings/constitution.js';
import { cliValue } from '../src/cli/settings.js';

function backend(over: Partial<SettingsV1> = {}) {
  const applied: SettingsChange[] = [];
  const s: SettingsV1 = {
    schemaVersion: 1, kind: 'ashlr-settings',
    autonomy: { level: 'propose', grantActive: true, maxLevel: 'autonomous' },
    repos: { enrolled: ['/r/locus'] }, schedules: [{ id: 'a1', name: 'x', enabled: true }],
    models: { allowedEngines: ['claude', 'codex'], available: ['claude', 'codex', 'devin-cli'] }, budget: { dailyUsd: 5, perItemMaxTokens: 200000, maxConcurrent: 4 },
    notifications: { desktop: false, proactive: false, slack: false, discord: false },
    constitution: { path: '/r/AGENTS.md', versions: [] }, ...over,
  };
  const be: SettingsBackend = { read: async () => s, apply: async (c) => { applied.push(c); return { ok: true, detail: 'saved' }; } };
  return { be, applied };
}

describe('settings', () => {
  it('humans can widen and narrow', async () => {
    const { be, applied } = backend();
    expect((await applySettingsChange(be, { key: 'budget.dailyUsd', value: 20 }, 'human')).status).toBe('applied');
    expect((await applySettingsChange(be, { key: 'autonomy.level', value: 'autonomous' }, 'human')).ok).toBe(true);
    expect(applied).toHaveLength(2);
  });

  it('agents may only narrow; widening returns needs-human with the exact command', async () => {
    const { be, applied } = backend();
    for (const ok of [{ key: 'budget.dailyUsd', value: 1 }, { key: 'autonomy.level', value: 'off' }, { key: 'schedules.disable', value: 'a1' }, { key: 'repos.unenroll', value: '/r/locus' }, { key: 'models.allowedEngines', value: ['claude'] }]) {
      expect((await applySettingsChange(be, ok, 'agent')).status).toBe('applied');
    }
    const cases: [unknown, string][] = [
      [{ key: 'budget.dailyUsd', value: 50 }, 'ashlr settings set budget.dailyUsd 50'],
      [{ key: 'autonomy.level', value: 'autonomous' }, 'ashlr settings set autonomy.level autonomous'],
      [{ key: 'repos.enroll', value: '/r/x' }, 'ashlr settings set repos.enroll /r/x'],
      [{ key: 'models.allowedEngines', value: ['claude', 'devin'] }, 'ashlr settings set models.allowedEngines claude,devin'],
      [{ key: 'constitution.save', value: { text: 'be bold' } }, 'ashlr settings set constitution.save --file <AGENTS.md>'],
    ];
    for (const [raw, command] of cases) {
      expect(await applySettingsChange(be, raw, 'agent')).toMatchObject({ ok: false, status: 'needs-human', direction: 'widening', command });
    }
    expect(applied).toHaveLength(5);
  });

  it('webhooks: agents may remove but never add or change; values are validated and never read back', async () => {
    const { be, applied } = backend({ notifications: { desktop: false, proactive: false, slack: true, discord: false } });
    expect((await applySettingsChange(be, { key: 'notifications.slackWebhook', value: '' }, 'agent')).status).toBe('applied');
    expect(await applySettingsChange(be, { key: 'notifications.discordWebhook', value: 'https://discord.com/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz' }, 'agent')).toMatchObject({ status: 'needs-human', command: 'ashlr settings set notifications.discordWebhook <webhook-url>' });
    expect((await applySettingsChange(be, { key: 'notifications.slackWebhook', value: 'https://evil.example/hook' }, 'human')).status).toBe('invalid');
    expect((await applySettingsChange(be, { key: 'notifications.slackWebhook', value: 'https://hooks.slack.com/services/T000/B000/XXXXXXXX' }, 'human')).status).toBe('applied');
    expect(applied).toHaveLength(2);
  });

  it('the grant caps autonomy for everyone', async () => {
    const { be } = backend({ autonomy: { level: 'propose', grantActive: false, maxLevel: 'propose' } });
    expect(await applySettingsChange(be, { key: 'autonomy.level', value: 'autonomous' }, 'human')).toMatchObject({ status: 'refused', command: 'ashlr ecosystem up' });
  });

  it('validation errors are actionable', () => {
    expect(parseSettingsChange({ key: 'nope', value: 1 })).toMatchObject({ ok: false, error: expect.stringContaining('key must be one of') });
    expect(parseSettingsChange({ key: 'budget.dailyUsd', value: -1 })).toMatchObject({ ok: false, error: 'budget.dailyUsd: must be a number from 0 to 1000' });
    expect(cliValue('notifications.desktop', 'on')).toBe(true);
    expect(cliValue('models.allowedEngines', 'a, b')).toEqual(['a', 'b']);
  });

  it('constitution saves are versioned and revertable', () => {
    const d = mkdtempSync(join(tmpdir(), 'const-'));
    const path = join(d, 'AGENTS.md'); const dir = join(d, 'v');
    writeFileSync(path, 'v1');
    const id1 = saveConstitution('v2', 'edit', path, dir, 1000);
    expect(readFileSync(path, 'utf8')).toBe('v2');
    expect(saveConstitution('v2', '', path, dir, 2000)).toBe('unchanged');
    expect(listVersions(dir)).toEqual([expect.objectContaining({ id: id1, note: 'edit', bytes: 2 })]);
    revertConstitution(id1, path, dir, 3000);
    expect(readFileSync(path, 'utf8')).toBe('v1');
    expect(listVersions(dir)).toHaveLength(2);
    expect(() => revertConstitution('../../etc', path, dir)).toThrow(/not a version id/);
  });
});

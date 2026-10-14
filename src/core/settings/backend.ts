/** Real SettingsBackend over config.json, the clamp, enrollment, automations and the constitution store. */
import { existsSync } from 'node:fs';
import type { SettingsBackend, SettingsChange, SettingsV1, AutonomyLevel } from './settings.js';

export async function realSettingsBackend(actorLabel: string): Promise<SettingsBackend> {
  const config = await import('../config.js');
  const policy = await import('../sandbox/policy.js');
  const automations = await import('../automations/index.js');
  const constitution = await import('./constitution.js');
  const read = async (): Promise<SettingsV1> => {
    const cfg = config.loadConfigReadOnly();
    const { readClamp } = await import('../authority/clamp.js');
    const { evaluateStandingAuthority, displaySurfaceTarget } = await import('../authority/effective-config.js');
    const ev = evaluateStandingAuthority({ mode: 'cached', surface: displaySurfaceTarget() });
    const path = constitution.constitutionPath();
    return {
      schemaVersion: 1, kind: 'ashlr-settings',
      autonomy: { level: readClamp().clamp.switch as AutonomyLevel, grantActive: ev.grantState === 'active', maxLevel: ev.grantState === 'active' ? 'autonomous' : 'propose' },
      repos: { enrolled: policy.listEnrolled() },
      schedules: (await automations.listAutomations()).map((a) => ({ id: a.id, name: a.name, enabled: a.enabled })),
      models: { allowedEngines: cfg.foundry?.allowedBackends ? [...cfg.foundry.allowedBackends] : null },
      budget: { dailyUsd: cfg.daemon?.dailyBudgetUsd ?? 1, perItemMaxTokens: cfg.daemon?.perItemMaxTokens ?? null, maxConcurrent: cfg.daemon?.maxConcurrent ?? null },
      notifications: { desktop: cfg.notify?.desktop === true, proactive: cfg.comms?.proactive === true, slack: !!cfg.notify?.slackWebhook, discord: !!cfg.notify?.discordWebhook },
      constitution: { path: existsSync(path) ? path : null, versions: constitution.listVersions() },
    };
  };
  const editConfig = (fn: (c: ReturnType<typeof config.loadConfig>) => void) => { const c = config.loadConfig(); fn(c); config.saveConfig(c); return { ok: true, detail: 'saved to ~/.ashlr/config.json' }; };
  const apply = async (ch: SettingsChange): Promise<{ ok: boolean; detail: string }> => {
    switch (ch.key) {
      case 'autonomy.level': {
        const { requestAutonomySwitch } = await import('../authority/effective-config.js');
        const r = requestAutonomySwitch(ch.value, 'mason', `settings (${actorLabel})`);
        return r.ok ? { ok: true, detail: r.changed ? `autonomy ${r.from} → ${r.to}` : 'unchanged' } : { ok: false, detail: r.reason };
      }
      case 'repos.enroll': { const r = policy.enroll(ch.value); return r.ok ? { ok: true, detail: r.changed ? `enrolled ${ch.value}` : 'unchanged' } : { ok: false, detail: String((r as { reason?: string }).reason ?? 'refused') }; }
      case 'repos.unenroll': { const r = policy.unenroll(ch.value); return r.ok ? { ok: true, detail: r.changed ? `unenrolled ${ch.value}` : 'unchanged' } : { ok: false, detail: String((r as { reason?: string }).reason ?? 'refused') }; }
      case 'schedules.enable': case 'schedules.disable': {
        const a = ch.key === 'schedules.enable' ? await automations.enableAutomation(ch.value) : await automations.disableAutomation(ch.value);
        return a ? { ok: true, detail: `${a.name} ${a.enabled ? 'on' : 'off'}` } : { ok: false, detail: `no automation ${ch.value}; list them with \`ashlr automations list\`` };
      }
      case 'models.allowedEngines': return editConfig((c) => { c.foundry = { ...(c.foundry ?? {}), allowedBackends: ch.value as never }; });
      case 'budget.dailyUsd': return editConfig((c) => { c.daemon = { ...(c.daemon ?? {}), dailyBudgetUsd: ch.value }; });
      case 'budget.perItemMaxTokens': return editConfig((c) => { c.daemon = { ...(c.daemon ?? {}), perItemMaxTokens: ch.value }; });
      case 'budget.maxConcurrent': return editConfig((c) => { c.daemon = { ...(c.daemon ?? {}), maxConcurrent: ch.value }; });
      case 'notifications.desktop': return editConfig((c) => { c.notify = { ...(c.notify ?? {}), desktop: ch.value }; });
      case 'notifications.proactive': return editConfig((c) => { c.comms = { ...(c.comms ?? {}), proactive: ch.value } as never; });
      case 'constitution.save': { const id = constitution.saveConstitution(ch.value.text, ch.value.note ?? ''); return { ok: true, detail: id === 'unchanged' ? 'unchanged' : `saved; previous text kept as version ${id}` }; }
      case 'constitution.revert': { try { const id = constitution.revertConstitution(ch.value); return { ok: true, detail: id === 'unchanged' ? 'unchanged' : `reverted to ${ch.value} (current text kept as ${id})` }; } catch (e) { return { ok: false, detail: (e as Error).message }; } }
    }
  };
  return { read, apply };
}

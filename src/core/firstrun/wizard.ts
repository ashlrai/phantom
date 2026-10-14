/**
 * First-run wizard (`ashlr welcome`, MCP `ashlr_welcome_status`, console
 * Welcome card on Today). It composes the ecosystem onboarding report and the
 * settings view into five steps and remembers which ones the human finished
 * or skipped (~/.ashlr/firstrun.json). Read model only: every step is applied
 * through `ashlr ecosystem up` or `ashlr settings set`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EcosystemReportV1 } from '../ecosystem/onboard.js';
import type { SettingsV1 } from '../settings/settings.js';

export type WizardStepId = 'github' | 'ecosystem' | 'budget' | 'notifications' | 'autonomy';
export interface WizardStep { id: WizardStepId; title: string; why: string; state: 'done' | 'todo' | 'skipped'; command: string; consoleHref: string }
export interface WizardV1 { schemaVersion: 1; kind: 'ashlr-welcome'; complete: boolean; steps: WizardStep[]; next: WizardStep | null }

export function firstRunPath(home = homedir()): string { return join(home, '.ashlr', 'firstrun.json'); }
export interface FirstRunMemory { finished: WizardStepId[]; skipped: WizardStepId[]; dismissedAt?: string }

export function readFirstRun(path = firstRunPath()): FirstRunMemory {
  try { const v = JSON.parse(readFileSync(path, 'utf8')) as FirstRunMemory; return { finished: v.finished ?? [], skipped: v.skipped ?? [], ...(v.dismissedAt ? { dismissedAt: v.dismissedAt } : {}) }; } catch { return { finished: [], skipped: [] }; }
}
export function markFirstRun(step: WizardStepId | 'dismiss', how: 'finished' | 'skipped', path = firstRunPath()): FirstRunMemory {
  const m = readFirstRun(path);
  if (step === 'dismiss') m.dismissedAt = new Date().toISOString();
  else { const list = m[how]; if (!list.includes(step)) list.push(step); }
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(m, null, 2), { mode: 0o600 });
  return m;
}

/** PURE */
export function buildWizard(eco: EcosystemReportV1, settings: SettingsV1, mem: FirstRunMemory): WizardV1 {
  const step = (s: EcosystemReportV1['steps'][number]['step']) => eco.steps.find((x) => x.step === s);
  const ok = (st?: { status: string }) => st?.status === 'done' || st?.status === 'already';
  const state = (id: WizardStepId, done: boolean): WizardStep['state'] => (done || mem.finished.includes(id) ? 'done' : mem.skipped.includes(id) ? 'skipped' : 'todo');
  const steps: WizardStep[] = [
    { id: 'github', title: 'Connect GitHub', why: 'Agents open and merge PRs as you.', state: state('github', ok(step('github'))), command: 'gh auth login -h github.com -s repo,workflow', consoleHref: '/control/ecosystem' },
    { id: 'ecosystem', title: 'Bring in your repos', why: 'Clone, enroll and check CI gates for every ecosystem repo.', state: state('ecosystem', ['workspace', 'enroll', 'grant'].every((s) => ok(step(s as never)))), command: 'ashlr ecosystem up', consoleHref: '/control/ecosystem' },
    { id: 'budget', title: 'Set a daily budget', why: `Metered spend stops at the cap (now $${settings.budget.dailyUsd}/day). Subscriptions and local models are separate.`, state: state('budget', false), command: `ashlr settings set budget.dailyUsd ${settings.budget.dailyUsd}`, consoleHref: '/control/settings' },
    { id: 'notifications', title: 'Choose notifications', why: 'Hear about things that need you, and nothing else.', state: state('notifications', settings.notifications.desktop || settings.notifications.proactive), command: 'ashlr settings set notifications.desktop on', consoleHref: '/control/settings' },
    { id: 'autonomy', title: 'Turn autonomy on', why: settings.autonomy.grantActive ? 'Let agents merge green PRs inside the grant.' : 'Needs the grant from step 2 first.', state: state('autonomy', settings.autonomy.level === 'autonomous'), command: 'ashlr settings set autonomy.level autonomous', consoleHref: '/control/settings' },
  ];
  const next = steps.find((s) => s.state === 'todo') ?? null;
  return { schemaVersion: 1, kind: 'ashlr-welcome', complete: next === null || !!mem.dismissedAt, steps, next };
}

export async function loadWizard(): Promise<WizardV1> {
  const { runEcosystemUp } = await import('../ecosystem/onboard.js');
  const { realEcosystemDeps } = await import('../ecosystem/onboard-deps.js');
  const { realSettingsBackend } = await import('../settings/backend.js');
  const [eco, settings] = await Promise.all([
    runEcosystemUp(await realEcosystemDeps({ withGrant: false }), { statusOnly: true }),
    (await realSettingsBackend('welcome')).read(),
  ]);
  return buildWizard(eco, settings, readFirstRun());
}

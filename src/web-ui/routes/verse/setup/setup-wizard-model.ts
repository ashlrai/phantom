/**
 * routes/verse/setup/setup-wizard-model.ts — pure helpers for the wizard UI.
 */
import type { SeatHealthReport } from '../../../../core/verse/health-types.js';
import type { ResourceEntry, ResourceKind } from '../../../../core/onboarding/resources-model.js';

export type SetupStepId = 'companions' | 'resources' | 'assistant' | 'context' | 'finish';

export const SETUP_STEPS: ReadonlyArray<{ id: SetupStepId; title: string; subtitle: string; primary: string }> = [
  { id: 'companions', title: 'Choose your toolkit', subtitle: 'Everything is on. Turn off anything you don’t want.', primary: 'Continue' },
  { id: 'resources', title: 'Connect your resources', subtitle: 'One account is enough. Add more any time.', primary: 'Continue' },
  { id: 'assistant', title: 'Your setup plan', subtitle: 'Run each step yourself. An assistant can walk you through it.', primary: 'Continue' },
  { id: 'context', title: 'Bring your context (optional)', subtitle: 'Reuse what Claude, Codex or Grok already know about you.', primary: 'Continue' },
  { id: 'finish', title: 'Check everything works', subtitle: 'A quick health check. You can re-run it from Settings.', primary: 'Finish' },
];

const ENGINE_KIND: Record<string, ResourceKind> = { claude: 'claude-code', codex: 'codex', grok: 'grok', devin: 'devin', local: 'ollama' };
const ENGINE_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok', devin: 'Devin', local: 'Local model' };

/** Smart default: every seat Phantom already sees becomes a personal resource. */
export function entriesFromSeats(seats: readonly SeatHealthReport[] | undefined, existing: readonly ResourceEntry[]): ResourceEntry[] {
  if (!seats) return [];
  const have = new Set(existing.map((e) => e.id));
  const counts: Record<string, number> = {};
  const out: ResourceEntry[] = [];
  for (const s of seats) {
    const kind = ENGINE_KIND[s.engine];
    if (!kind) continue;
    counts[s.engine] = (counts[s.engine] ?? 0) + 1;
    const id = `seat:${s.seatId}`;
    if (have.has(id)) continue;
    const n = seats.filter((x) => x.engine === s.engine).length;
    out.push({ id, kind, label: n > 1 ? `${ENGINE_LABEL[s.engine]} ${counts[s.engine]}` : ENGINE_LABEL[s.engine]!, scope: 'personal', scopeName: null, credentialName: null });
  }
  return out;
}

export interface HealthTally {
  connected: number;
  attention: number;
  unknown: number;
}

export function tallySeats(seats: readonly SeatHealthReport[] | undefined): HealthTally | null {
  if (!seats) return null;
  const t: HealthTally = { connected: 0, attention: 0, unknown: 0 };
  for (const s of seats) {
    if (s.connection === 'connected') t.connected += 1;
    else if (s.connection === 'unknown') t.unknown += 1;
    else t.attention += 1;
  }
  return t;
}

/**
 * routes/verse/setup/setup-wizard-store.ts — the setup wizard's open state and
 * the user's answers (companion toggles, resource entries, confirmed steps).
 *
 * Persisted under `ashlr.verse.setup-wizard.v1`. Holds NAMES ONLY: labels,
 * scopes and credential names — there is no field for a secret value, and
 * entries are re-validated on read so a hand-edited record cannot smuggle one.
 */
import { normaliseSelection, type CompanionId } from '../../../../core/ecosystem/companion-manifest.js';
import { looksLikeSecretValue, type ResourceEntry } from '../../../../core/onboarding/resources-model.js';
import type { ProposalDecision } from '../../../../core/onboarding/setup-assistant.js';

export const SETUP_WIZARD_STORAGE_KEY = 'ashlr.verse.setup-wizard.v1';

export interface SetupWizardState {
  open: boolean;
  step: number;
  companions: Record<CompanionId, boolean>;
  resources: ResourceEntry[];
  decisions: Record<string, ProposalDecision>;
  completedAt: string | null;
}

function cleanEntries(raw: unknown): ResourceEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is ResourceEntry =>
    !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.kind === 'string' && typeof e.label === 'string' &&
    !looksLikeSecretValue(`${e.label} ${e.scopeName ?? ''} ${e.credentialName ?? ''}`),
  );
}

function read(): SetupWizardState {
  const base: SetupWizardState = { open: false, step: 0, companions: normaliseSelection(null), resources: [], decisions: {}, completedAt: null };
  try {
    const raw = localStorage.getItem(SETUP_WIZARD_STORAGE_KEY);
    if (!raw) return base;
    const p = JSON.parse(raw) as Partial<SetupWizardState>;
    return {
      ...base,
      companions: normaliseSelection(p.companions),
      resources: cleanEntries(p.resources),
      decisions: p.decisions && typeof p.decisions === 'object' ? p.decisions : {},
      completedAt: typeof p.completedAt === 'string' ? p.completedAt : null,
    };
  } catch {
    return base;
  }
}

let state = read();
const listeners = new Set<() => void>();

function set(delta: Partial<SetupWizardState>): void {
  state = { ...state, ...delta };
  try {
    const { open: _o, step: _s, ...persisted } = state;
    localStorage.setItem(SETUP_WIZARD_STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    /* best effort */
  }
  for (const l of listeners) l();
}

export const subscribeSetupWizard = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const getSetupWizardState = () => state;

export const openSetupWizard = () => set({ open: true, step: 0 });
export const closeSetupWizard = () => set({ open: false });
export const setSetupStep = (step: number) => set({ step: Math.max(0, Math.trunc(step)) });
export const toggleCompanion = (id: CompanionId, on: boolean) => set({ companions: { ...state.companions, [id]: on } });
export const addResource = (entry: ResourceEntry) => set({ resources: [...state.resources.filter((r) => r.id !== entry.id), entry] });
export const removeResource = (id: string) => set({ resources: state.resources.filter((r) => r.id !== id) });
export const decide = (id: string, d: ProposalDecision) => set({ decisions: { ...state.decisions, [id]: d } });
export const completeSetupWizard = () => set({ open: false, completedAt: new Date().toISOString() });

/** Test hygiene. */
export function resetSetupWizard(): void {
  try {
    localStorage.removeItem(SETUP_WIZARD_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  state = read();
  for (const l of listeners) l();
}

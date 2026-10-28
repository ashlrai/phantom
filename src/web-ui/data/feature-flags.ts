/** Per-browser UI opt-ins. These are presentation flags, never authority grants. */
export type FeatureFlag = 'agentWorkspace';
export const FEATURE_FLAGS_STORAGE_KEY = 'ashlr.feature-flags.v1';

let agentWorkspace: boolean | undefined;
const listeners = new Set<() => void>();

function readAgentWorkspace(): boolean {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY) ?? 'null');
    // Project only the known boolean; never retain arbitrary persisted fields.
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      && Object.hasOwn(raw, 'agentWorkspace')
      && (raw as Record<string, unknown>)['agentWorkspace'] === true;
  } catch {
    return false;
  }
}

export function getFeatureFlag(name: FeatureFlag): boolean {
  if (name !== 'agentWorkspace') return false;
  agentWorkspace ??= readAgentWorkspace();
  return agentWorkspace;
}

export function setFeatureFlag(name: FeatureFlag, enabled: boolean): void {
  if (name !== 'agentWorkspace' || typeof enabled !== 'boolean') return;
  if (getFeatureFlag(name) === enabled) return;
  agentWorkspace = enabled;
  try {
    // Write a fresh allowlisted object, never a merge with untrusted storage.
    localStorage.setItem(FEATURE_FLAGS_STORAGE_KEY, JSON.stringify({ agentWorkspace: enabled }));
  } catch {
    /* The choice still holds for this page when persistence is unavailable. */
  }
  for (const listener of [...listeners]) listener();
}

export function subscribeFeatureFlags(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam: emulate a reload without changing the saved preference. */
export function resetFeatureFlagsForTests(): void {
  agentWorkspace = undefined;
  for (const listener of [...listeners]) listener();
}

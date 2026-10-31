/** Per-browser UI opt-ins. These are presentation flags, never authority grants. */
export type FeatureFlag = 'agentWorkspace' | 'oneAsk';
export const FEATURE_FLAGS_STORAGE_KEY = 'ashlr.feature-flags.v1';

const KNOWN_FLAGS: readonly FeatureFlag[] = ['agentWorkspace', 'oneAsk'];

const cache = new Map<FeatureFlag, boolean>();
const listeners = new Set<() => void>();

function readStored(): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY) ?? 'null');
    // Project only the known booleans; never retain arbitrary persisted fields.
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function getFeatureFlag(name: FeatureFlag): boolean {
  if (!KNOWN_FLAGS.includes(name)) return false;
  let value = cache.get(name);
  if (value === undefined) {
    value = readStored()[name] === true;
    cache.set(name, value);
  }
  return value;
}

export function setFeatureFlag(name: FeatureFlag, enabled: boolean): void {
  if (!KNOWN_FLAGS.includes(name) || typeof enabled !== 'boolean') return;
  if (getFeatureFlag(name) === enabled) return;
  cache.set(name, enabled);
  try {
    // Write a fresh allowlisted object, never a merge with untrusted storage.
    localStorage.setItem(
      FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(KNOWN_FLAGS.map((flag) => [flag, getFeatureFlag(flag)]))),
    );
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
  cache.clear();
  for (const listener of [...listeners]) listener();
}

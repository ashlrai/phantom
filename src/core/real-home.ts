/**
 * Nullable account-home API used by authority readers. Both this API and the
 * throwing utility share one resolver, including demo isolation and fixtures.
 */
import {
  __setRealHomeForTests,
  canonicalRealHome,
} from './util/real-home.js';

/** Account home, or null when it cannot be resolved. */
export function realHome(): string | null {
  return canonicalRealHome();
}

/** Vitest only. Keep authority inside a fixture's relocated HOME. */
export function useProcessHomeForTest(): void {
  if (process.env.VITEST !== 'true') throw new Error('Real home test controls are unavailable.');
  __setRealHomeForTests('homedir');
}

/** Vitest only. Ignore the fixture HOME and use the account home. */
export function useAccountHomeForTest(): void {
  if (process.env.VITEST !== 'true') throw new Error('Real home test controls are unavailable.');
  __setRealHomeForTests(null);
}

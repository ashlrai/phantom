/**
 * Devin v3 is on when a cog_ key is in DEVIN_API_KEY and an org id is present.
 * The org id may come from DEVIN_ORG_ID or from the catalog default. The key
 * is never read from the catalog, a file, or a log line.
 */

import { DEVIN_KEY_PATTERN, DEVIN_ORG_ID_PATTERN } from '../../devin/types.js';

/** Verified service-user org. Not a secret. */
export const DOCUMENTED_DEVIN_ORG_ID = 'org-c65eb6611a9c4a3697fa7e6630d101d6';

export interface DevinCredentials {
  apiKey: string;
  orgId: string;
}

export function resolveDevinOrgId(env: NodeJS.ProcessEnv, configured?: string | null): string | null {
  const fromEnv = env['DEVIN_ORG_ID']?.trim();
  if (fromEnv) return DEVIN_ORG_ID_PATTERN.test(fromEnv) ? fromEnv : null;
  const fallback = configured?.trim() || DOCUMENTED_DEVIN_ORG_ID;
  return DEVIN_ORG_ID_PATTERN.test(fallback) ? fallback : null;
}

/**
 * The key is `process.env.DEVIN_API_KEY` only. A caller-supplied env bag, a
 * catalog secret name, and `SecretLookup.get` cannot supply it.
 */
export function devinApiKeyFromProcess(): string | null {
  const value = process.env['DEVIN_API_KEY'];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!DEVIN_KEY_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/** Both values must be present. An empty or non-cog_ key disables the adapter. */
export function devinCredentials(env: NodeJS.ProcessEnv, configuredOrg?: string | null): DevinCredentials | null {
  const apiKey = devinApiKeyFromProcess();
  if (!apiKey) return null;
  const orgId = resolveDevinOrgId(env, configuredOrg);
  if (!orgId) return null;
  return { apiKey, orgId };
}

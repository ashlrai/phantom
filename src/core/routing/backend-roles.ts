/**
 * Privileged dispatch roles for a backend billing class.
 *
 * Local and loopback endpoints already cannot hold merge authority: the merge
 * gate requires a frontier tier, and local inference refuses abliterated
 * weights in any role that can hold credentials or feed a merge. Subscription
 * coding CLIs are the same kind of unprivileged producer. Metered API backends
 * stay on that list too: enabling one for work is not merge or credential
 * authority.
 *
 * Produce and review are the worker roles (edit the worktree, open a draft PR).
 * Pure. No I/O.
 */

import { isBillingClass, type BillingClass } from './billing-class.js';

export type DispatchRole = 'produce' | 'review' | 'merge' | 'credential';

export const DISPATCH_ROLES: readonly DispatchRole[] = ['produce', 'review', 'merge', 'credential'];

const UNPRIVILEGED: ReadonlySet<BillingClass> = new Set(['subscription', 'metered', 'local', 'loopback']);

export function isDispatchRole(value: unknown): value is DispatchRole {
  return typeof value === 'string' && (DISPATCH_ROLES as readonly string[]).includes(value);
}

/**
 * True only for produce and review. Merge and credential are refused for every
 * billing class this policy knows. Frontier API merge authority stays on
 * proposals that do not carry a billing class, in evaluateMergeAuthority.
 */
export function roleAllowed(billing: BillingClass, role: DispatchRole): boolean {
  if (!isBillingClass(billing) || !isDispatchRole(role)) return false;
  if (role === 'merge' || role === 'credential') return !UNPRIVILEGED.has(billing);
  return role === 'produce' || role === 'review';
}

/** Sentence for a refused merge, or null when this proposal carries no billing class. */
export function billingBlocksMerge(billing: BillingClass | undefined): string | null {
  if (!billing) return null;
  if (!isBillingClass(billing)) return 'billing class is not recognized, so merge authority is refused';
  if (roleAllowed(billing, 'merge')) return null;
  return `billing class '${billing}' never holds merge authority`;
}

/** Sentence for a refused credential role, or null when the role is allowed. */
export function billingBlocksCredential(billing: BillingClass | undefined): string | null {
  if (!billing) return 'billing class is required before a credential role can be considered';
  if (!isBillingClass(billing)) return 'billing class is not recognized, so the credential role is refused';
  if (roleAllowed(billing, 'credential')) return null;
  return `billing class '${billing}' never holds a credential role`;
}

/**
 * How a backend is billed. This is a routing fact, separate from trust tier.
 *
 * subscription: a locally logged-in coding CLI draws on an included allowance.
 * metered: a per-token or credit API (for example grok while XAI_API_KEY is the
 *          billing mode). Off until an operator explicitly enables it.
 * local: weights on this machine.
 * loopback: an OpenAI-compatible server on a loopback URL.
 *
 * Browser-safe and pure. No I/O.
 */

export const BILLING_CLASSES = ['subscription', 'metered', 'local', 'loopback'] as const;

export type BillingClass = (typeof BILLING_CLASSES)[number];

export function isBillingClass(value: unknown): value is BillingClass {
  return typeof value === 'string' && (BILLING_CLASSES as readonly string[]).includes(value);
}

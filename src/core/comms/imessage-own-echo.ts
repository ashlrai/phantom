/** Fixed Phantom texts that Messages can deliver back as received self-chat rows. */
export const PHANTOM_OUTBOUND_FIXED = ['Phantom: reply YES to get fleet updates here.'] as const;

/** Exact, case-sensitive matches only: quoted or longer owner messages remain input. */
export function isPhantomOwnEcho(text: string, recentOutbound?: readonly string[]): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && (
    PHANTOM_OUTBOUND_FIXED.some(fixed => trimmed === fixed)
    || (recentOutbound?.some(outbound => trimmed === outbound.trim()) ?? false)
  );
}

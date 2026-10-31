import { useEffect } from 'react';
import { PRODUCT_NAME } from '../../../app/product-brand.js';
import { useFleetRunsBadge, type FleetRunsBadge } from './fleet-runs-badge.js';

export function formatWindowTitle({ badge }: { badge: FleetRunsBadge | null; title?: string }, _nowMs?: number): string {
  if (!badge) return PRODUCT_NAME;
  let title = badge.paused
    ? `${PRODUCT_NAME} · ⏸ paused · ${badge.workers} working`
    : `${PRODUCT_NAME} · ${badge.workers} working`;
  if (badge.paused) return title.length > 80 ? `${title.slice(0, 79)}…` : title;
  if (badge.merges !== null) title += ` · ${badge.merges} merged/h`;
  if (badge.heldLanes?.length) title += badge.heldLanes.length === 1 ? ` · ${badge.heldLanes[0]} held` : ` · ${badge.heldLanes.length} lanes held`;
  if (badge.switchesOn.length) title += ' · switches on';
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

export function useWindowTitle(): void {
  const badge = useFleetRunsBadge();
  const title = badge ? formatWindowTitle({ badge }) : null;
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const previous = document.title;
    return () => { if (document.title !== previous) document.title = previous; };
  }, []);
  useEffect(() => {
    if (typeof document !== 'undefined' && title !== null && document.title !== title) document.title = title;
  }, [title]);
}

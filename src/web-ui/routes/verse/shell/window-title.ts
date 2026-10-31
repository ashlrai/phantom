import { useEffect, useRef } from 'react';
import { PRODUCT_NAME } from '../../../app/product-brand.js';
import { fleetReadsFailingText, useFleetRunsBadge, type FleetRunsBadge } from './fleet-runs-badge.js';

export function formatWindowTitle({ badge }: { badge: FleetRunsBadge | null; title?: string }, _nowMs?: number): string {
  if (!badge) return PRODUCT_NAME;
  let title = badge.paused
    ? `${PRODUCT_NAME} · ⏸ paused · ${badge.workers} working`
    : `${PRODUCT_NAME} · ${badge.workers} working`;
  const failing = fleetReadsFailingText(badge);
  const suffix = failing ? ` · ${failing}` : '';
  const limit = 80 - suffix.length;
  const finish = () => `${title.length > limit ? `${title.slice(0, limit - 1)}…` : title}${suffix}`;
  if (badge.paused) return finish();
  if (badge.merges !== null) title += ` · ${badge.merges} merged/h`;
  if (badge.heldLanes?.length) title += badge.heldLanes.length === 1 ? ` · ${badge.heldLanes[0]} held` : ` · ${badge.heldLanes.length} lanes held`;
  if (badge.switchesOn.length) title += ' · switches on';
  return finish();
}

export function useWindowTitle(): void {
  const badge = useFleetRunsBadge();
  const hadFleetTitle = useRef(false);
  const title = badge || hadFleetTitle.current ? formatWindowTitle({ badge }) : null;
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const previous = document.title;
    return () => { if (document.title !== previous) document.title = previous; };
  }, []);
  useEffect(() => {
    if (title !== null) hadFleetTitle.current = true;
    if (typeof document !== 'undefined' && title !== null && document.title !== title) document.title = title;
  }, [title]);
}

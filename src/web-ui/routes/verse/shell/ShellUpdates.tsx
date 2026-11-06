import { useEffect } from 'react';
import { useAutoSelfUpdate } from '../sections/useAutoSelfUpdate.js';
import { useSelfUpdateBadge } from './self-update-badge.js';

/** Background update observers start after the shell can paint. */
export default function ShellUpdates({ onLabel }: { onLabel: (label: string | null) => void }) {
  useAutoSelfUpdate();
  const label = useSelfUpdateBadge()?.label ?? null;
  useEffect(() => { onLabel(label); }, [label, onLabel]);
  return null;
}

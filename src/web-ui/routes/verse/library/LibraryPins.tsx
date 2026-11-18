/**
 * routes/verse/library/LibraryPins.tsx: Mason's pins in the Library. A pin
 * toggle sits on memory cards and bus rows; pinned items gather in a group at
 * the top. Pins are refs and titles only (server: core/verse/library-pins-api.ts),
 * shared with `ashlr fleet library-pins` and the fleet context pack.
 */
import { useState } from 'react';
import type { LibraryPinKind } from '../../../../core/fleet/library-pins.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { refetchQuery } from '../../../data/cache.js';
import { ApiError, apiPost } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import { CardNote } from '../command/Surface.js';
import { oneShotFetcher } from '../health/health-queries.js';
import { VerseMutationLockedError } from '../verse-queries.js';
import { libraryPinsQuery, LIBRARY_PINS_PATH, LIBRARY_PINS_KEY, type PinsResponse } from './library-queries.js';
export { libraryPinsQuery, LIBRARY_PINS_PATH, LIBRARY_PINS_KEY } from './library-queries.js';
import styles from './library.module.css';

const TITLE_MAX = 160;

async function mutatePins(body: Record<string, string>): Promise<void> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<PinsResponse>(LIBRARY_PINS_PATH, body, token);
  touchMutationHold();
  await refetchQuery(LIBRARY_PINS_KEY, oneShotFetcher(() => Promise.resolve(result), () => libraryPinsQuery.fetch()), true);
}

function failure(err: unknown): string {
  if (err instanceof ApiError) return err.detail || err.message;
  return err instanceof Error ? err.message : 'Pinning failed.';
}

export function PinToggle({ kind, pinRef, title, visible = true }: { kind: LibraryPinKind; pinRef: string; title: string; visible?: boolean }) {
  const pins = useQuery(libraryPinsQuery, { enabled: visible });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!pins.data) return null;
  const pinned = pins.data.pins.find((pin) => pin.kind === kind && pin.ref === pinRef);
  const toggle = () => {
    setBusy(true);
    setError(null);
    const label = title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
    mutatePins(pinned ? { remove: pinned.id } : { kind, ref: pinRef, title: label })
      .catch((err: unknown) => setError(failure(err)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <button type="button" className={styles.button} aria-pressed={!!pinned} disabled={busy} onClick={toggle}
        aria-label={`${pinned ? 'Unpin' : 'Pin'} ${title}`}>
        {pinned ? 'Unpin' : 'Pin'}
      </button>
      {error ? <span role="alert" className={styles.meta}>{error}</span> : null}
    </>
  );
}

/** Pinned items, newest first; nothing renders until something is pinned. */
export function PinnedGroup({ visible = true }: { visible?: boolean }) {
  const pins = useQuery(libraryPinsQuery, { enabled: visible });
  if (pins.error && !pins.data) return <CardNote tone="danger">Could not read pins: {failure(pins.error)}</CardNote>;
  if (pins.data && !Array.isArray(pins.data.pins)) return <CardNote tone="danger">Pinned items unavailable.</CardNote>;
  if (!pins.data?.pins.length) return null;
  return (
    <section className={styles.section} aria-label="Pinned">
      <h2>Pinned</h2>
      <p className={styles.meta}>Agents see these in their context pack and with ashlr fleet library-pins.</p>
      <ul className={styles.bus}>
        {pins.data.pins.map((pin) => (
          <li key={pin.id} className={styles.busRow}>
            <span className={styles.busWho}>{pin.kind}</span>
            <span className={styles.busText}>{pin.title}</span>
            <span className={styles.meta}>{pin.ref}</span>
            <PinToggle kind={pin.kind} pinRef={pin.ref} title={pin.title} visible={visible} />
          </li>
        ))}
      </ul>
    </section>
  );
}

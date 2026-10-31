/**
 * app/UpdateReloadBanner.tsx — "Phantom updated — Reload", the last mile of
 * self-update for the person at the screen. After the sidecar restarts on
 * new code the server reports a new build, but the page is still the OLD
 * interface bundle and silently disagrees with it; this slim top banner
 * says so and offers a reload. Mounted lazily from VerseConsoleApp so it
 * costs the chat's first paint nothing (scripts/check-first-paint-budget.mjs
 * counts only static imports).
 *
 * Behavior:
 *   - Reads GET /api/verse/ops/self-update on mount, then every 60 s while
 *     the document is visible.
 *   - Keeps the FIRST healthy reading in a ref: the page-load baseline the
 *     'server-restarted' trigger compares headSha against.
 *   - On the desktop shell's `ashlr:sidecar-restarted` event refetches at
 *     once, and again after 5 s — the new sidecar may still be starting, and
 *     its route (or git state) may only answer on the second try.
 *   - 404s and errors render nothing; the poll simply asks again next tick —
 *     the route may only exist after a restart onto newer code.
 *   - "Later" remembers the dismissed headSha in sessionStorage so the same
 *     build stays quiet, but a further update asks again.
 *
 * The browser never gains install authority: Reload is `location.reload()`,
 * nothing more.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { Button } from '../components/primitives/Button.js';
import { useQuery, useRefetch } from '../data/hooks.js';
import { APP_VERSION } from '../routes/verse/sections/app-version.js';
import { subscribeChunkErrors } from './chunk-error.js';
import { SIDECAR_RESTARTED_EVENT } from './sidecar-restart.js';
import { decideReload, type UpdateReloadReading } from './update-reload-model.js';
import { updateReloadQuery } from './update-reload-query.js';

const POLL_MS = 60_000;
/** Second look after a sidecar restart: the new server may still be coming up. */
const RESTART_RECHECK_MS = 5_000;
const DISMISSED_KEY = 'ashlr.verse.update-reload.dismissed';

const subscribeVisibility = (listener: () => void): (() => void) => {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};
const visible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';

function readDismissed(): string | null {
  try { return window.sessionStorage.getItem(DISMISSED_KEY); } catch { return null; }
}

export function UpdateReloadBanner() {
  const isVisible = useSyncExternalStore(subscribeVisibility, visible, () => true);
  const { data } = useQuery(updateReloadQuery, { enabled: isVisible });
  const refetch = useRefetch(updateReloadQuery);
  const firstRef = useRef<UpdateReloadReading | null>(null);
  const [chunkError, setChunkError] = useState(false);
  const [dismissedSha, setDismissedSha] = useState<string | null>(readDismissed);
  // "Later" has no sha to remember on an interface-behind reading without a
  // headSha; sessionStorage dies with the page anyway, so a mount flag is
  // the same lifetime.
  const [nullShaDismissed, setNullShaDismissed] = useState(false);

  const reading: UpdateReloadReading | null = data ?? null;
  useEffect(() => {
    if (!firstRef.current && reading?.sourceState === 'healthy') firstRef.current = reading;
  }, [reading]);

  useEffect(() => {
    if (!isVisible) return;
    const timer = window.setInterval(() => refetch(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [isVisible, refetch]);

  useEffect(() => {
    let retry: number | undefined;
    const onRestart = (): void => {
      refetch();
      window.clearTimeout(retry);
      retry = window.setTimeout(() => refetch(), RESTART_RECHECK_MS);
    };
    window.addEventListener(SIDECAR_RESTARTED_EVENT, onRestart);
    return () => {
      window.removeEventListener(SIDECAR_RESTARTED_EVENT, onRestart);
      window.clearTimeout(retry);
    };
  }, [refetch]);

  useEffect(() => subscribeChunkErrors(() => {
    setChunkError(true);
    refetch();
  }), [refetch]);

  const decision = decideReload({ first: firstRef.current, current: reading, appVersion: APP_VERSION, dismissedSha, chunkError });
  if (!decision.show || (decision.reason !== 'chunk-missing' && decision.sha === null && nullShaDismissed)) return null;

  const later = (): void => {
    if (decision.sha === null) setNullShaDismissed(true);
    else {
      try { window.sessionStorage.setItem(DISMISSED_KEY, decision.sha); } catch { /* storage can refuse; the state below still holds it for this page */ }
      setDismissedSha(decision.sha);
    }
  };

  return (
    <div role="status" style={barStyle}>
      <span style={messageStyle}>{decision.message}</span>
      <Button size="sm" variant="primary" onClick={() => window.location.reload()}>Reload</Button>
      {decision.reason !== 'chunk-missing' && <Button size="sm" variant="ghost" onClick={later}>Later</Button>}
    </div>
  );
}

/** Slim top strip over the shell; a CSS module was out of scope for this change. */
const barStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexShrink: 0,
  padding: 'var(--space-2) var(--space-4)', background: 'var(--bg-surface-raised)',
  borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-primary)',
  fontSize: 'var(--text-sm-size)', lineHeight: 'var(--text-sm-line)',
};

const messageStyle: CSSProperties = {
  flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

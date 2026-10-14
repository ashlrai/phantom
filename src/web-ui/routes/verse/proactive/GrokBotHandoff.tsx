/** Mounted only for an explicit review. Copying is a manual transfer, never provider dispatch. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Button } from '../../../components/primitives/Button.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { getMutationToken, hasMutationHold } from '../../../data/auth-store.js';
import { useMutationHold } from '../../../data/hooks.js';
import { useTokenGate } from '../context/use-token-gate.js';
import { fetchGrokBotHandoffPreview, type GrokBotHandoffPreview, type GrokBotHandoffRequest } from './proactive-queries.js';
import styles from './GrokBotHandoff.module.css';

export interface GrokBotHandoffProps {
  request: GrokBotHandoffRequest; packetDigest: string; leaseExpiresAt: string; deadline: string | null;
  disabled: boolean; onClose: () => void;
}
export function GrokBotHandoff({ request, packetDigest, leaseExpiresAt, deadline, disabled, onClose }: GrokBotHandoffProps) {
  const { run, dialog } = useTokenGate();
  const hold = useMutationHold();
  const key = JSON.stringify([request, packetDigest, leaseExpiresAt, deadline]);
  const expiry = Math.min(Date.parse(leaseExpiresAt), deadline === null ? Infinity : Date.parse(deadline));
  const [clock, setClock] = useState(Date.now);
  const [preview, setPreview] = useState<{ key: string; value: GrokBotHandoffPreview } | null>(null);
  const [reviewed, setReviewed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fallback, setFallback] = useState<{ key: string; text: string } | null>(null);
  const active = useRef<AbortController | null>(null);
  const alive = useRef(false);
  const generation = useRef(0);
  const flight = useRef(false);
  const previewToken = useRef<string | null>(null);
  const latest = useRef({ key, request, packetDigest, expiry, disabled, preview, reviewed });
  latest.current = { key, request, packetDigest, expiry, disabled, preview, reviewed };
  const expired = !Number.isFinite(expiry) || expiry <= clock;
  const shown = preview?.key === key && !disabled && !expired && hold.hasHold && previewToken.current === hold.token ? preview.value : null;
  const checked = !!shown && reviewed === shown.previewDigest;
  const cancelPending = useCallback(() => {
    active.current?.abort(); generation.current++; flight.current = false;
  }, []);

  const transact = useCallback(async (copy: boolean) => {
    if (flight.current) return;
    const context = latest.current;
    const previous = context.preview?.key === context.key ? context.preview.value : null;
    if (context.disabled || !Number.isFinite(context.expiry) || context.expiry <= Date.now()
      || copy && (!previous || context.reviewed !== previous.previewDigest)) return;
    if (copy && (!hasMutationHold() || getMutationToken() !== previewToken.current)) {
      setPreview(null); setReviewed(null); setFallback(null); setError('Action authorization changed. Refresh and review the brief again.'); return;
    }
    const controller = new AbortController();
    active.current?.abort(); active.current = controller;
    const epoch = ++generation.current;
    let actionToken: string | null = null;
    const liveContext = () => alive.current && !controller.signal.aborted && generation.current === epoch
      && latest.current.key === context.key && !latest.current.disabled && latest.current.expiry > Date.now();
    const current = () => liveContext() && hasMutationHold() && (actionToken === null || getMutationToken() === actionToken);
    flight.current = true; setBusy(true); setError(null); setNotice(null); setFallback(null);
    if (!copy) { previewToken.current = null; setPreview(null); setReviewed(null); }
    try {
      const fresh = await run(copy ? 'Recheck this exact reviewed brief before copying; no provider will be contacted'
        : 'Review a local Grok Bot brief; no provider will be contacted', () => {
        if (!current()) throw new DOMException('Aborted', 'AbortError');
        actionToken = getMutationToken();
        return fetchGrokBotHandoffPreview({ ...context.request,
          ...(copy && previous ? { expectedPreviewDigest: previous.previewDigest } : {}) }, context.packetDigest, controller.signal);
      });
      if (!current() || !fresh) return;
      if (!copy) { previewToken.current = actionToken; setPreview({ key: context.key, value: fresh }); return; }
      if (!previous || fresh.previewDigest !== previous.previewDigest || fresh.briefText !== previous.briefText) {
        throw new Error('changed-brief');
      }
      // No asynchronous clipboard work starts until the exact server recheck and local fence pass.
      try {
        if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('clipboard-unavailable');
        await navigator.clipboard.writeText(fresh.briefText);
        if (current()) setNotice('Brief copied. Paste it into the intended Grok Bot yourself; no provider was contacted.');
      } catch {
        if (current()) {
          setFallback({ key: context.key, text: fresh.briefText });
          setNotice('Clipboard unavailable. Select the rechecked brief below and copy it manually.');
        }
      }
    } catch {
      if (liveContext()) {
        setPreview(null); setReviewed(null); setFallback(null);
        setError('The current brief could not be confirmed. Refresh coordination or profiles, then review again. Nothing was copied.');
      }
    } finally {
      if (alive.current && generation.current === epoch) { flight.current = false; setBusy(false); }
    }
  }, [run]);

  useEffect(() => {
    alive.current = true;
    if (!disabled) void transact(false);
    return () => { alive.current = false; cancelPending(); };
  }, [key, disabled, transact, cancelPending]);
  useEffect(() => {
    if (!Number.isFinite(expiry)) return;
    const timer = setTimeout(() => { cancelPending(); setBusy(false); setClock(Date.now()); }, Math.max(0, expiry - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [expiry, cancelPending]);
  function close() { cancelPending(); dialog.onClose(); onClose(); }
  return <>
    <Dialog open onClose={close} titleId="grok-bot-handoff" title="Review Grok Bot brief"
      description="Review a locally supplied task for manual transfer. Copying does not contact Grok Bot, grant access, or prove acceptance or completion.">
      <div className={styles.content}>
        {expired || disabled ? <p role="alert">This assignment is no longer current. Refresh coordination before reviewing another brief.</p> : null}
        {busy && !disabled && !expired ? <p role="status" aria-busy="true">{shown ? 'Rechecking the reviewed brief…' : 'Preparing the current brief…'}</p> : null}
        {error ? <p role="alert" className={styles.error}>{error}</p> : null}
        {shown ? <><pre className={styles.brief} tabIndex={0} aria-label="Grok Bot brief">{shown.briefText}</pre>
          <label className={styles.review}><input type="checkbox" checked={checked} disabled={busy || disabled || expired}
            onChange={event => { setReviewed(event.target.checked ? shown.previewDigest : null); setFallback(null); setNotice(null); }} />I reviewed this exact brief and its intended recipient</label></> : null}
        {notice && !disabled && !expired ? <p role="status">{notice}</p> : null}
        {fallback?.key === key && checked && !disabled && !expired ? <label className={styles.manual}>Rechecked brief for manual copy
          <textarea readOnly rows={10} value={fallback.text} onFocus={event => event.currentTarget.select()} /></label> : null}
        <div className={styles.actions}><Button variant="ghost" onClick={close}>Close</Button>
          <Button variant="subtle" disabled={busy || disabled || expired} onClick={() => void transact(false)}>Refresh brief</Button>
          <Button variant="primary" disabled={!checked || busy || disabled || expired} onClick={() => void transact(true)}>Recheck and copy brief</Button></div>
      </div>
    </Dialog>
    <MutationTokenDialog {...dialog} tokenLabel="Mutation token" tokenHelp="the mutation token phm verse printed" />
  </>;
}

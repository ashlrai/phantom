import { useState } from 'react';
import { runtimeIdentityQuery } from '../fleet-host/runtime-identity-query.js';
import { coordinationClaimsQuery } from '../fleet-board/coordination-claims-query.js';
import { workBoardQuery } from '../fleet-board/work-board-section.js';
import { formatStatusEvidence, type EvidenceState, type StatusEvidenceInput } from './status-evidence.js';

const STATES: readonly string[] = ['RECEIVED', 'ASSIGNED', 'RUNNING', 'BLOCKED', 'VERIFIED'];
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' ? v as Record<string, unknown> : null);

/** A failed or absent read is "unknown", never an error to the operator. */
async function settle<T>(read: Promise<T>): Promise<T | null> {
  try { return await read; } catch { return null; }
}

/** Newest Slack item, preferring one with a named owner and claim receipt. */
function pickOwner(board: unknown): Pick<StatusEvidenceInput, 'owner' | 'state'> {
  const b = obj(board);
  if (b === null || b['inbox'] !== 'ok' || !Array.isArray(b['items'])) return { owner: null, state: null };
  const items = (b['items'] as unknown[]).map(obj).filter((i): i is Record<string, unknown> => i !== null && i['channel'] === 'slack');
  const newest = (x: Record<string, unknown>[]) =>
    [...x].sort((p, q) => Date.parse(text(q['receivedAt']) ?? '') - Date.parse(text(p['receivedAt']) ?? '') || 0)[0];
  const pick = newest(items.filter((i) => text(i['owner']) !== null && text(i['claimReceipt']) !== null)) ?? newest(items);
  if (pick === undefined) return { owner: null, state: null };
  const result = obj(pick['result']);
  const pr = typeof result?.['pr'] === 'number' ? `PR #${result['pr']}` : null;
  const artifact = result?.['kind'] === 'verified'
    ? pr ?? text(result['head']) ?? (text(result['tests']) ? `tests: ${text(result['tests'])}` : null) : null;
  const state = text(pick['state']);
  return {
    owner: { name: text(pick['owner']), receipt: text(pick['claimReceipt']), artifact, asOf: text(b['asOf']) },
    state: state !== null && STATES.includes(state) ? state as EvidenceState : null,
  };
}

/** One click: fresh reads of the three facts, copied to the clipboard as Slack-ready text. */
export function StatusEvidenceButton() {
  const [label, setLabel] = useState('Copy status for Dot');
  const [busy, setBusy] = useState(false);

  async function copy() {
    setBusy(true);
    const [runtime, ledger, board] = await Promise.all([
      settle(runtimeIdentityQuery.fetch(new AbortController().signal)),
      settle(coordinationClaimsQuery.fetch(new AbortController().signal)),
      settle(workBoardQuery.fetch(new AbortController().signal)),
    ]);
    const body = formatStatusEvidence({
      runtime: runtime ? { host: runtime.host, version: runtime.installedVersion, pid: null, asOf: runtime.asOf } : null,
      claims: ledger && ledger.state === 'known' ? { count: ledger.claims.length, asOf: ledger.generatedAt } : null,
      ...pickOwner(board),
      now: Date.now(),
    });
    try {
      await navigator.clipboard.writeText(body);
      setLabel('Copied');
    } catch {
      setLabel('Copy failed');
    }
    setBusy(false);
    setTimeout(() => setLabel('Copy status for Dot'), 2000);
  }

  return <button type="button" disabled={busy} onClick={() => { void copy(); }} aria-live="polite">{label}</button>;
}

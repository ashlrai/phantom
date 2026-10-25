/**
 * `phm receipt timeline <run>`: one run's signed receipt, whether it verifies,
 * and the custody spawns recorded during that run's window. Value-free: counts,
 * digests, engine names, outcomes and timestamps only. No secret names, values,
 * repo paths or prompts. The repo field is reduced to a present/absent flag.
 *
 * The custody ledger has no run id, so spawns are attributed by time: the
 * window is [created_at - wall_ms - slack, created_at + slack]. Overlapping
 * runs on the same host share spawns; the output says so (`attribution: "window"`).
 */
import { readReceiptV1 } from './receipt-store.js';
import { readCustodyWindow, type CustodyWindowEntry } from '../run/custody-ledger.js';

export const TIMELINE_WINDOW_SLACK_MS = 60_000;

export type ReceiptTimeline =
  | { runId: string; found: false; verified: false; reason: string }
  | {
      runId: string;
      found: true;
      verified: boolean;
      reason: string | null;
      keyId: string | null;
      digest: string | null;
      createdAt: string;
      wallMs: number;
      engine: string;
      execution: string;
      secrets: { injected: number | null; wrapped: boolean | null };
      change: { filesTouched: number; lines: number; outsideGrantScope: number };
      window: { from: string; to: string; attribution: 'window' };
      spawns: { total: number; wrapped: number; unwrapped: number; malformed: number; entries: CustodyWindowEntry[] };
    };

export interface TimelineDeps {
  read?: typeof readReceiptV1;
  custody?: typeof readCustodyWindow;
}

export function buildReceiptTimeline(runId: string, deps: TimelineDeps = {}): ReceiptTimeline {
  const r = (deps.read ?? readReceiptV1)(runId);
  // Only a verified receipt is trusted enough to show; anything else reports why it failed and nothing else.
  const body = r.ok ? r.receipt : null;
  if (!body) return { runId, found: false, verified: false, reason: r.ok ? 'unknown' : r.reason };
  const created = Date.parse(body.created_at);
  const wall = Number.isFinite(body.spend.wall_ms) && body.spend.wall_ms >= 0 ? body.spend.wall_ms : 0;
  const from = new Date(created - wall - TIMELINE_WINDOW_SLACK_MS);
  const to = new Date(created + TIMELINE_WINDOW_SLACK_MS);
  const c = (deps.custody ?? readCustodyWindow)(from, to);
  const wrapped = c.entries.filter((e) => e.wrapped).length;
  return {
    runId,
    found: true,
    verified: true,
    reason: null,
    keyId: body.sig.key_id,
    digest: r.ok ? r.digest : null,
    createdAt: body.created_at,
    wallMs: wall,
    engine: body.identity.engine,
    execution: body.outcome.execution,
    secrets: { injected: body.secrets.injected_names_count, wrapped: body.secrets.wrap ? body.secrets.wrap.wrapped : null },
    change: { filesTouched: body.change.files_touched, lines: body.change.lines, outsideGrantScope: body.change.outside_grant_scope.length },
    window: { from: from.toISOString(), to: to.toISOString(), attribution: 'window' },
    spawns: { total: c.entries.length, wrapped, unwrapped: c.entries.length - wrapped, malformed: c.malformed, entries: c.entries },
  };
}

export function formatReceiptTimeline(t: ReceiptTimeline): string {
  if (!t.found) return `receipt ${t.runId}: NOT verified (${t.reason})`;
  const lines = [
    `receipt ${t.runId}: ${t.verified ? 'verified' : `NOT verified (${t.reason})`}${t.keyId ? ` · key ${t.keyId.slice(0, 12)}` : ''}${t.digest ? ` · digest ${t.digest.slice(0, 12)}` : ''}`,
    `  run      ${t.createdAt} · ${Math.round(t.wallMs / 1000)}s · engine ${t.engine} · ${t.execution}`,
    `  secrets  ${t.secrets.injected ?? 'unknown'} injected · wrap ${t.secrets.wrapped === null ? 'unknown' : t.secrets.wrapped ? 'yes' : 'no'}`,
    `  change   ${t.change.filesTouched} files · ${t.change.lines} lines · ${t.change.outsideGrantScope} outside grant scope`,
    `  custody  ${t.spawns.total} spawns in window (${t.spawns.wrapped} wrapped, ${t.spawns.unwrapped} unwrapped${t.spawns.malformed ? `, ${t.spawns.malformed} malformed` : ''}); window attribution, overlapping runs share spawns`,
  ];
  for (const e of t.spawns.entries) lines.push(`    ${e.at}  ${e.engine}  ${e.wrapped ? 'wrapped' : `unwrapped (${e.reason})`}`);
  return lines.join('\n');
}

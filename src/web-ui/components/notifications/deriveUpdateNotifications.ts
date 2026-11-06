/**
 * components/notifications/deriveUpdateNotifications.ts — the self-update
 * lane of the attention queue: ready, failed, and successful applies as
 * stable notification items alongside the Updates row
 * (sections/UpdateStatusRow.tsx).
 *
 * Two sources, read exactly as the row merges them:
 *   - The native desktop updater (app/desktop-updates.ts DesktopUpdateState):
 *     event-driven, carries a real semver `version` and a kebab-case
 *     `reason`. `staged` / `waiting-for-idle` / `waiting-for-app-quit` mean
 *     "downloaded — ready to install"; `adoption-held` means staged but the
 *     guard is blocking install on something the operator controls;
 *     `installing` is the apply in flight; `installed` / `current` mean
 *     applied; `failed` carries the reason.
 *   - The server self-update probe (sections/update-status-queries.ts
 *     ServerObservation): `behind > 0 && canFastForward` is the exact
 *     condition UpdateNowButton enables on ("ready to apply" for a source
 *     checkout — the commits are already fetched), and `lastApply`
 *     (sections/about-update-model.ts lastApplyOf) is the durable record of
 *     the last apply — `failed` and `refused` keep their `reason`;
 *     `updated` / `already-current` are applied.
 *
 * Dedupe rides the store's id rule: at most one item per distinct version
 * per state, keyed `update-ready:<version>` / `update-held:<version>` /
 * `update-failed:<version>:<reason-hash>` / `update-restart-needed:<sha>` /
 * `update-applied:<sha>` — a NEW version lands a NEW item (and a fresh OS
 * mirror), the same one updates in place. Nothing while checking, idle,
 * downloading or applying; already-current applies remain silent.
 */
import { describeDesktopUpdateReason } from '../../app/desktop-update-reasons.js';
import type { DesktopUpdateState } from '../../app/desktop-updates.js';
import { lastApplyOf } from '../../routes/verse/sections/about-update-model.js';
import type { ServerObservation } from '../../routes/verse/sections/update-status-queries.js';
import { setVerseSection } from '../../routes/verse/verse-ui-store.js';
import type { AppNotification } from './types.js';

/** Native phases where the download is complete and install can start. */
const READY_PHASES = new Set<DesktopUpdateState['phase']>(['staged', 'waiting-for-idle', 'waiting-for-app-quit']);
/**
 * `lastApply` is durable history — an apply this old is a Work Journal
 * fact, not a recent notification (same 24h convention
 * deriveNotifications uses for run failures).
 */
const LAST_APPLY_NOTIFY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The reason field is unvetted wire data — never let it grow past this. */
const REASON_MAX_CHARS = 140;

const shortSha = (sha: string | null | undefined): string | null => sha === null || sha === undefined ? null : sha.slice(0, 7);

/**
 * Scrub a reason before it reaches a title: collapse whitespace, drop
 * path-like and token/hash-like runs (a reason must never carry a path or
 * a credential fragment into a notification), cap at REASON_MAX_CHARS.
 */
function safeReason(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
    .replace(/\S*[\\/]\S*/g, '…')
    .replace(/[A-Za-z0-9_-]{24,}/g, '…');
  return flat.length > REASON_MAX_CHARS ? `${flat.slice(0, REASON_MAX_CHARS - 1)}…` : flat;
}

/** FNV-1a — the same scheme deriveFleetRunsNotifications hashes run text with. */
function reasonHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < Math.min(text.length, 24); i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

/** Settings ▸ Desktop ▸ Updates — the same call the gear tray's update entry makes. */
const openUpdatesSettings = (): void => setVerseSection('settings');

export function deriveUpdateNotifications(
  status: ServerObservation,
  now: number,
  native: DesktopUpdateState | null = null,
): AppNotification[] {
  const out: AppNotification[] = [];
  const nowIso = new Date(now).toISOString();
  const push = (item: AppNotification): void => { out.push(item); };

  // ── Native desktop updater (the packaged app's own updater). ──────────
  if (native !== null) {
    const version = native.version ?? 'update';
    const tag = native.version ?? 'unknown';
    if (READY_PHASES.has(native.phase)) {
      push({ id: `update-ready:${tag}`, category: 'action-required', severity: 'high',
        title: `Phantom ${version} is ready to install`,
        detail: 'Installs automatically when Phantom is next idle.',
        ts: nowIso, actionLabel: 'Update now', actionRun: openUpdatesSettings });
    } else if (native.phase === 'adoption-held') {
      push({ id: `update-held:${tag}`, category: 'action-required', severity: 'high',
        title: `Update to ${version} is held`,
        detail: describeDesktopUpdateReason(native.reason),
        ts: nowIso, actionLabel: 'Open Updates', actionRun: openUpdatesSettings });
    } else if (native.phase === 'failed') {
      const reason = safeReason(describeDesktopUpdateReason(native.reason));
      push({ id: `update-failed:${tag}:${reasonHash(native.reason ?? 'unknown')}`,
        category: 'action-required', severity: 'critical',
        title: `Update to ${version} failed: ${reason}`,
        detail: 'The step log and retry live in Settings ▸ Desktop ▸ Updates.',
        ts: nowIso, actionLabel: 'Open Updates', actionRun: openUpdatesSettings });
    }
  }

  // ── Server self-update probe (the source-checkout fast-forward path). ──
  if (status !== null && !('kind' in status)) {
    if (status.canFastForward === true && status.behind !== null && status.behind > 0 && status.dirty !== true) {
      const target = shortSha(status.originSha) ?? 'origin';
      const branch = status.branch ? `origin/${status.branch}` : 'origin';
      push({ id: `update-ready:${target}`, category: 'action-required', severity: 'high',
        title: `Phantom ${target} is ready to install`,
        detail: `${status.behind} commit${status.behind === 1 ? '' : 's'} behind ${branch} — the tree is clean and a fast-forward is provable.`,
        ts: status.lastFetchAt ?? nowIso, actionLabel: 'Update now', actionRun: openUpdatesSettings });
    }
    const last = lastApplyOf(status);
    if (last !== null && (last.outcome === 'failed' || last.outcome === 'refused')
      && now - Date.parse(last.finishedAt) <= LAST_APPLY_NOTIFY_WINDOW_MS) {
      const reason = safeReason(last.reason ?? 'No reason was provided.');
      const target = shortSha(last.toCommit) ?? 'unknown';
      push({ id: `update-failed:${target}:${reasonHash(last.reason ?? 'none')}`,
        category: 'action-required', severity: 'critical',
        title: `Update to ${target} ${last.outcome}: ${reason}`,
        detail: 'The step log and retry live in Settings ▸ Desktop ▸ Updates.',
        ts: last.finishedAt, actionLabel: 'Open Updates', actionRun: openUpdatesSettings });
    }
    if (last !== null && last.outcome === 'updated'
      && now - Date.parse(last.finishedAt) <= LAST_APPLY_NOTIFY_WINDOW_MS) {
      const target = shortSha(last.toCommit) ?? 'unknown';
      const restartNeeded = last.restartRequired && last.fromCommit !== null && status.headSha === last.fromCommit;
      if (restartNeeded) {
        push({ id: `update-restart-needed:${target}`, category: 'action-required', severity: 'high',
          title: `Phantom updated to ${target}; restart to load it`,
          detail: last.restartMode === 'manual' ? 'Quit and reopen Phantom to run the new code.'
            : 'Phantom restarts itself when idle.',
          ts: last.finishedAt, actionLabel: 'Open Updates', actionRun: openUpdatesSettings });
      } else {
        const minutes = Math.max(0, Math.floor((now - Date.parse(last.finishedAt)) / 60_000));
        const from = shortSha(last.fromCommit);
        push({ id: `update-applied:${target}`, category: 'daemon-health', severity: 'info',
          title: `Now running ${target}`,
          detail: `Updated ${minutes} min ago${from === null ? '' : ` from ${from}`}`,
          ts: last.finishedAt });
      }
    }
  }
  return out;
}

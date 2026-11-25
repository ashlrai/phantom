import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { isSlackChannelId, isSlackTs } from '../agents/slack-network.js';
import { readSlackEvidenceBundle } from '../agents/slack-evidence-bundle.js';
import { readSlackRequestTrace, type SlackRequestTraceRead } from '../agents/slack-request-trace.js';

type ScopedOptions = { channelId?: string; maxAgeSeconds?: number };
type EvidenceBundle = ReturnType<typeof readSlackEvidenceBundle>;
type ScopedReader = (thread: string, options: ScopedOptions) => EvidenceBundle | Promise<EvidenceBundle>;
type SlackTraceEvidenceRow = EvidenceBundle['rows'][number];

export const SLACK_TRACE_ROWS = 20;
export const SLACK_TRACE_TIMEOUT_MS = 5_000;

function countSelectedRows(rows: readonly SlackTraceEvidenceRow[]) {
  const counts = { total: rows.length, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 };
  for (const row of rows) {
    if (row.outcome === 'answered') counts.answered++;
    else if (row.outcome === 'uncertain') counts.uncertain++;
    else if (row.outcome === 'bus-failed') counts.busFailed++;
    else counts.unanswered++;
  }
  return counts;
}

function sameSlackTimestamp(left: unknown, right: string): boolean {
  if (!isSlackTs(left) || !isSlackTs(right)) return false;
  const normalize = (value: string) => {
    const [seconds, fraction] = value.split('.');
    return [seconds!.replace(/^0+/, ''), fraction!.replace(/0+$/, '')];
  };
  const [leftSeconds, leftFraction] = normalize(left);
  const [rightSeconds, rightFraction] = normalize(right);
  return leftSeconds === rightSeconds && leftFraction === rightFraction;
}

/**
 * The CLI `--message` post-filter on a collected bundle: keep only the rows
 * for the selected channel+message, recompute counts, echo the selection and
 * -- when a freshness bound was requested -- recompute the verdict over the
 * selected rows only (empty selection is 'unknown', never inherited from
 * siblings). Runs before the SLACK_TRACE_ROWS presentation cap.
 */
function selectSlackTraceMessage(bundle: EvidenceBundle, channelId: string, messageTs: string, maxAgeSeconds: number | undefined): EvidenceBundle {
  const rows = bundle.rows.filter((row) => row.channelId === channelId && sameSlackTimestamp(row.messageTs, messageTs));
  const asOfMs = Date.parse(bundle.asOf);
  return {
    ...bundle,
    rows,
    counts: countSelectedRows(rows),
    selection: { channelId, messageTs },
    ...(maxAgeSeconds !== undefined ? { freshness: {
      maxAgeSeconds,
      verdict: rows.length === 0 ? 'unknown' : rows.every((row) => {
        const observed = Date.parse(row.at);
        const age = asOfMs - observed;
        return Number.isFinite(observed) && age >= 0 && age / 1000 <= maxAgeSeconds;
      }) ? 'fresh' : 'stale',
      basis: 'Persisted ingress observation times; asOf is collection time, not a live probe.',
    } } : {}),
  } as EvidenceBundle;
}

/** Read-only: the trace never sends, ledgers or appends to the bus. Rows are ids and timestamps only. */
export function createFleetSlackTraceApi(
  read: () => SlackRequestTraceRead | Promise<SlackRequestTraceRead> = () => readSlackRequestTrace(),
  readScoped: ScopedReader = (thread, options) => readSlackEvidenceBundle(thread, options),
): ApiModule {
  return async (_ctx, req, res, path, method) => {
    if (path !== '/api/verse/fleet/control/slack-trace') return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    const params = new URL(req.url ?? path, 'http://localhost').searchParams;
    const keys = [...params.keys()];
    const thread = params.get('thread');
    const channel = params.get('channel');
    const message = params.get('message');
    const age = params.get('maxAgeSeconds');
    const maxAgeSeconds = age === null ? undefined : Number(age);
    if (keys.some((key) => !['thread', 'channel', 'message', 'maxAgeSeconds'].includes(key) || params.getAll(key).length !== 1) ||
        (keys.length > 0 && (thread === null || !isSlackTs(thread))) ||
        (channel !== null && !isSlackChannelId(channel)) ||
        (message !== null && (!isSlackTs(message) || channel === null)) ||
        (age !== null && (!/^[0-9]+$/.test(age) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds! <= 0))) {
      sendJson(res, 400, { error: 'invalid query parameters' }); return true;
    }
    const options: ScopedOptions = {};
    if (channel !== null) options.channelId = channel;
    if (maxAgeSeconds !== undefined) options.maxAgeSeconds = maxAgeSeconds;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const trace = await Promise.race([
        Promise.resolve().then(() => thread === null ? read() : readScoped(thread, options)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), SLACK_TRACE_TIMEOUT_MS); }),
      ]);
      // Rows arrive oldest first. A `message` query selects one request after
      // scoped collection; the newest-20 presentation cap applies after it.
      const selected = message === null ? trace
        : selectSlackTraceMessage(trace as EvidenceBundle, channel as string, message, maxAgeSeconds);
      const truncated = selected.rows.length > SLACK_TRACE_ROWS;
      sendJson(res, 200, { ...selected, rows: selected.rows.slice(-SLACK_TRACE_ROWS).reverse(), truncated });
    } catch { sendJson(res, 503, { error: 'slack trace unavailable' }); }
    finally { if (timer) clearTimeout(timer); }
    return true;
  };
}
export const handleFleetSlackTraceApi = createFleetSlackTraceApi();

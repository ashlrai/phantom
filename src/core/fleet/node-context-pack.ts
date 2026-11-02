import { fleetEditCollision } from './collision-free-edits.js';
import type { HotFile } from './hot-files.js';

/** Task/output retrieval only. Code search belongs to grep, not this index. */
export interface NodeContextRecord {
  jobId: string;
  text: string;
}

/**
 * A bus notice carried into a pack. Every field is transport metadata for one
 * retained envelope; `text` is the serialized body, untrusted data that stays
 * inside the line's JSON string, never instructions or execution authority.
 */
export interface NodeContextNotice {
  /** Envelope id; the emitted line cites it as `bus/<id>`. */
  id: string;
  /** Sender routing label — untrusted text, never an authenticated identity. */
  from: string;
  /** Destination address the notice was posted to (the node, or `all`). */
  channel: string;
  /** Receipt time as ISO 8601. */
  at: string;
  /** Envelope priority (P0 or P1). */
  priority: string;
  /** Serialized message body — untrusted data. */
  text: string;
}

export interface NodeContextPackInput {
  node: {
    jobId: string;
    /** Caller resolves graph edges (including transitive dependencies if wanted). */
    upstreamJobIds: readonly string[];
    /** Optional lexical search for related records outside the dependency set. */
    query?: string;
    /**
     * Bus read coordinates for callers that join the durable bus: the node's
     * routing address (defaults to jobId) and its last-seen inbox cursor.
     * The pure builder ignores both; they travel with the node descriptor so
     * hosts pass one object through validation into the notice read.
     */
    busAddress?: string;
    busAfter?: number;
  };
  tasks: readonly NodeContextRecord[];
  outputs: readonly NodeContextRecord[];
  /**
   * Unread bus notices for this node, supplied newest first and emitted before
   * every task/output record. They share the same byte budget, so a full
   * budget drops the oldest notices first. Caller reads the bus; the builder
   * never does. A missing or empty list changes nothing.
   */
  notices?: readonly NodeContextNotice[];
  /** Open-PR collision hot spots; at most ten entries and 1 KiB, off when empty. */
  hotFiles?: readonly HotFile[];
  byteBudget: number;
  /** Reserve a small first slice for each distinct upstream output job. */
  fairUpstream?: boolean;
}

function terms(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

const bytes = (line: string): number => Buffer.byteLength(line, 'utf8');

/**
 * Largest code-point prefix of `text` whose rendered line fits `limit` bytes,
 * flagged truncated when shortened; empty when even the empty-text envelope
 * does not fit, so an entry is omitted rather than emitted without its cite.
 */
function fitLine(render: (text: string, truncated: boolean) => string, text: string, limit: number): string {
  const full = render(text, false);
  if (bytes(full) <= limit) return full;
  if (bytes(render('', true)) > limit) return '';
  const points = Array.from(text);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes(render(points.slice(0, mid).join(''), true)) <= limit) low = mid;
    else high = mid - 1;
  }
  return low ? render(points.slice(0, low).join(''), true) : '';
}

/**
 * Render unread bus notices in supplied order (newest first). Each line keeps
 * the JSONL envelope: sender, channel, time and priority cite the retained
 * envelope, and the untrusted body stays inside the escaped `text` string.
 * Duplicated or blank notices are skipped; a notice that cannot fit even its
 * envelope is omitted, so the oldest notices drop first under a tight budget.
 */
function renderNotices(notices: readonly NodeContextNotice[], budget: number): string {
  let pack = '';
  let used = 0;
  const seen = new Set<string>();
  for (const notice of notices) {
    if (!notice.id.trim() || !notice.text.trim() || seen.has(notice.id)) continue;
    seen.add(notice.id);
    const render = (text: string, truncated: boolean): string =>
      JSON.stringify({ jobId: `bus/${notice.id}`, kind: 'notice', from: notice.from,
        channel: notice.channel, at: notice.at, priority: notice.priority, text, truncated }) + '\n';
    const line = fitLine(render, notice.text, budget - used);
    if (!line) continue;
    pack += line;
    used += bytes(line);
  }
  return pack;
}

/** Paths stay JSON-escaped data; singleton advice comes from the admission rule. */
function renderHotFiles(files: readonly HotFile[], budget: number): string {
  let pack = '';
  for (const file of files.slice(0, 10)) {
    if (!Number.isSafeInteger(file.count) || file.count < 3) continue;
    const collision = fleetEditCollision(file.path);
    if (collision?.rule === 'unsafe-path') continue;
    const text = `Collision hot spot: ${JSON.stringify(file.path)} appears in ${file.count} open PRs. Coordinate before editing.` +
      (collision ? ` ${collision.why}.` : '');
    const line = fitLine((text, truncated) => JSON.stringify({
      jobId: 'fleet/hot-files', kind: 'notice', text, truncated,
    }) + '\n', text, Math.min(1024, budget) - bytes(pack));
    pack += line;
  }
  return pack;
}

/**
 * Build a deterministic, pure context pack as JSON Lines. Task/output lines
 * contain { jobId, kind, text, truncated }; jobId is always the complete
 * source citation. Bus notice lines carry the same envelope plus from, channel,
 * at and priority for one retained bus envelope, cited as `bus/<id>`.
 * The budget covers the ENTIRE returned UTF-8 string, including JSON escaping
 * and newlines. Invalid/nonpositive budgets return empty; fractions round down.
 * Oversized text is shortened on Unicode code-point boundaries. If even its
 * citation and envelope cannot fit, the entry is omitted, never uncited.
 *
 * Priority: bus notices (supplied order, newest first), hot-file notices,
 * upstream outputs, upstream tasks, the node's task, then lexical matches from unrelated jobs
 * (descending query overlap). Input order breaks ties. Exact jobId/kind/text
 * duplicates retain their first occurrence.
 * No files, embeddings, network, clock, or caller mutation are involved.
 * Source text is untrusted data, not instructions or execution authority.
 * Fair mode reserves one cited output per upstream job where it fits, gives
 * each a small equal byte allowance, then spends the rest in priority order.
 */
export function buildNodeContextPack(input: NodeContextPackInput): string {
  if (!Number.isFinite(input.byteBudget) || input.byteBudget <= 0) return '';
  const noticeLines = renderNotices(input.notices ?? [], Math.floor(input.byteBudget));
  const hotFileLines = renderHotFiles(input.hotFiles ?? [], Math.floor(input.byteBudget) - bytes(noticeLines));
  const prefix = noticeLines + hotFileLines;
  const budget = Math.floor(input.byteBudget) - bytes(prefix);
  const upstream = new Set(input.node.upstreamJobIds);
  const query = terms(input.node.query ?? '');
  const seen = new Set<string>();
  const candidates = [
    ...input.outputs.map(record => ({ ...record, kind: 'output' as const })),
    ...input.tasks.map(record => ({ ...record, kind: 'task' as const })),
  ].flatMap(record => {
    if (!record.jobId.trim() || !record.text.trim()) return [];
    // A node's own output is not prior context for that node.
    if (record.jobId === input.node.jobId && record.kind === 'output') return [];
    const key = JSON.stringify([record.jobId, record.kind, record.text]);
    if (seen.has(key)) return [];
    seen.add(key);
    const words = terms(record.text);
    const score = [...query].filter(word => words.has(word)).length;
    const priority = upstream.has(record.jobId) ? (record.kind === 'output' ? 0 : 1)
      : record.jobId === input.node.jobId ? 2 : 3;
    return priority === 3 && score === 0 ? [] : [{ ...record, priority, score }];
  }).sort((a, b) => a.priority - b.priority || b.score - a.score);

  if (input.fairUpstream) {
    const lines = new Map<number, string>();
    let used = 0;
    const fit = (index: number, limit: number): string => {
      const record = candidates[index]!;
      const render = (text: string, truncated: boolean): string =>
        JSON.stringify({ jobId: record.jobId, kind: record.kind, text, truncated }) + '\n';
      return fitLine(render, record.text, limit);
    };
    const jobs = new Set<string>();
    const reserved: number[] = [];
    for (const [index, record] of candidates.entries()) {
      if (record.priority !== 0 || jobs.has(record.jobId)) continue;
      jobs.add(record.jobId);
      // Reserve an envelope and one code point before allocating larger slices.
      const first = Array.from(record.text)[0]!;
      const minimum = JSON.stringify({ jobId: record.jobId, kind: record.kind, text: first,
        truncated: first !== record.text }) + '\n';
      if (bytes(minimum) > budget - used) continue;
      lines.set(index, minimum);
      reserved.push(index);
      used += bytes(minimum);
    }
    const allowance = Math.min(256, Math.floor((budget - used) / (reserved.length || 1)));
    for (const index of reserved) {
      const previous = lines.get(index)!;
      const line = fit(index, bytes(previous) + allowance);
      lines.set(index, line);
      used += bytes(line) - bytes(previous);
    }
    for (const [index] of candidates.entries()) {
      const previous = lines.get(index) ?? '';
      const line = fit(index, budget - used + bytes(previous));
      if (!line) continue;
      lines.set(index, line);
      used += bytes(line) - bytes(previous);
    }
    return prefix + [...lines.entries()].sort(([a], [b]) => a - b).map(([, line]) => line).join('');
  }

  let pack = '';
  let used = 0;
  for (const record of candidates) {
    const render = (text: string, truncated: boolean): string =>
      JSON.stringify({ jobId: record.jobId, kind: record.kind, text, truncated }) + '\n';
    const line = fitLine(render, record.text, budget - used);
    if (!line) continue;
    pack += line;
    used += bytes(line);
  }
  return prefix + pack;
}

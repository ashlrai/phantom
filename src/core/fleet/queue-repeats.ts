export interface QueueLine {
  id: string;
  /** Only READY and CLAIMED lines count; anything else is ignored. */
  status: string;
  repo: string;
  /** When the line was queued (ISO). Lines without a usable time are skipped. */
  at: string;
  /** Full task text: it must name a target file and an "Acceptance:" clause. */
  text: string;
}

export interface QueueRepeat {
  id: string;
  /** The earliest line in the window it repeats. */
  repeatOf: string;
  repo: string;
  file: string;
  /** All ids sharing the key, earliest first. */
  group: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FILE = /(?:[\w.-]+\/)*[\w.-]+\.(?:test\.)?(?:tsx?|mjs|cjs|js|jsx|py|rs|go|md|json|ya?ml|toml|sh|css|html)\b/i;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The target file is the first path-like token before the acceptance clause. */
function keyOf(line: QueueLine): { file: string; key: string } | null {
  const at = line.text.search(/acceptance\s*:/i);
  if (at < 0) return null;
  const file = FILE.exec(line.text.slice(0, at))?.[0]?.toLowerCase();
  const acceptance = norm(line.text.slice(at).replace(/^acceptance\s*:/i, ''));
  const repo = norm(line.repo);
  return file && acceptance && repo ? { file, key: `${repo}\n${file}\n${acceptance}` } : null;
}

/**
 * Count READY/CLAIMED lines from the last 24 h that repeat an earlier line with
 * the same repo, target file and acceptance. The earliest line of each group is
 * the original and is not counted; ties on time fall back to input order.
 */
export function queueRepeats(lines: readonly QueueLine[], now: number = Date.now(), top = 5) {
  const live = lines.flatMap((line, index) => {
    const time = Date.parse(line.at);
    const keyed = keyOf(line);
    const open = ['READY', 'CLAIMED'].includes(line.status.toUpperCase());
    return open && keyed && Number.isFinite(time) && time <= now && now - time <= DAY_MS
      ? [{ line, time, index, ...keyed }] : [];
  }).sort((a, b) => a.time - b.time || a.index - b.index);
  const groups = new Map<string, typeof live>();
  for (const row of live) groups.set(row.key, [...(groups.get(row.key) ?? []), row]);
  const repeats: QueueRepeat[] = [];
  for (const rows of groups.values()) for (const row of rows.slice(1)) {
    repeats.push({ id: row.line.id, repeatOf: rows[0]!.line.id, repo: row.line.repo, file: row.file, group: rows.map(r => r.line.id) });
  }
  // Biggest groups first so the worst offenders lead the examples.
  repeats.sort((a, b) => b.group.length - a.group.length || a.id.localeCompare(b.id));
  return { schema: 'fleet.queue-repeats.v1' as const, repeats: repeats.length, examples: repeats.slice(0, top) };
}

export function validQueueLines(value: unknown): value is QueueLine[] {
  return Array.isArray(value) && value.every(row => row && typeof row === 'object'
    && ['id', 'status', 'repo', 'at', 'text'].every(k => typeof (row as Record<string, unknown>)[k] === 'string'));
}

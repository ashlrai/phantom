/**
 * gap-proposal-record.ts: the gap proposer's own record of what it queued.
 *
 * One JSON line per gap job written to the drop queue, in `<runsDir>/metrics/gap-proposed.jsonl`:
 * `{"at":<iso>,"id":"GAP…","title":"…","repo":"phantom"}`. Two readers use it:
 *   - the dedupe guard in job-gaps.ts: a gap proposed in the last 24 h is not proposed again;
 *   - `phm doctor supply`: the "proposed" count of the Self-supply line.
 * A missing or unreadable file reads as unknown, never as zero.
 */
import { appendFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const GAP_PROPOSAL_RECORD = 'gap-proposed.jsonl';
export const GAP_PROPOSAL_WINDOW_MS = 24 * 3_600_000;
const MAX_BYTES = 1024 * 1024;

export interface GapProposal { at: string; id: string; title: string; repo: string }
export type GapProposalRead = { state: 'known'; path: string; proposals: GapProposal[] } | { state: 'unknown'; path: string; why: string };

export const gapProposalPath = (runsDir: string): string => join(runsDir, 'metrics', GAP_PROPOSAL_RECORD);

/** Appends one line per proposal. Refuses a symlinked record. Throws on failure; the caller treats that as non-fatal. */
export async function recordGapProposal(runsDir: string, entry: GapProposal): Promise<void> {
  const path = gapProposalPath(runsDir);
  await mkdir(join(runsDir, 'metrics'), { recursive: true });
  const stat = await lstat(path).catch(() => null);
  if (stat && !stat.isFile()) throw new Error('gap proposal record is not a file');
  await appendFile(path, `${JSON.stringify(entry)}\n`, { flag: 'a' });
}

/** Proposals made in the last 24 h (newest read window: the last 1 MiB). Bad lines are skipped. */
export async function readGapProposals(runsDir: string, nowMs: number): Promise<GapProposalRead> {
  const path = gapProposalPath(runsDir);
  let text: string;
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) return { state: 'unknown', path, why: 'unreadable' };
    text = (await readFile(path, 'utf8')).slice(-MAX_BYTES);
  } catch (e) { return { state: 'unknown', path, why: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' }; }
  const proposals: GapProposal[] = [];
  for (const line of text.split('\n')) {
    try {
      const r = JSON.parse(line) as Partial<GapProposal>;
      const at = typeof r.at === 'string' ? Date.parse(r.at) : NaN;
      if (typeof r.id !== 'string' || typeof r.title !== 'string' || !Number.isFinite(at)) continue;
      if (nowMs - at >= GAP_PROPOSAL_WINDOW_MS || at > nowMs + 60_000) continue;
      proposals.push({ at: r.at!, id: r.id, title: r.title, repo: typeof r.repo === 'string' ? r.repo : 'phantom' });
    } catch { /* skip bad line */ }
  }
  return { state: 'known', path, proposals };
}

import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { FLEET_RUNS_INBOX_MAX_CHARS } from '../verse/fleet-runs-types.js';

export interface OutboxEntry {
  at: string;
  text: string;
}

const MAX_READ_BYTES = 256 * 1024;
// The leader's outbox is free-form Markdown; the first ISO 8601 or
// "YYYY-MM-DD HH:MM" run in a "## " heading is the entry's time and every
// other heading word stays as text.
const HEADING_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?|\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

function cap(text: string): string {
  return scrubSecrets(text).slice(0, FLEET_RUNS_INBOX_MAX_CHARS);
}

/** Oldest-first file order, keeping the newest `limit` entries. */
export function parseOutbox(markdown: string, limit = 30): OutboxEntry[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  if (!lines.some(line => line.startsWith('## '))) {
    const text = markdown.replace(/\r\n/g, '\n').trim();
    return text ? [{ at: '', text: cap(text) }] : [];
  }
  const entries: OutboxEntry[] = [];
  let openEntry = false;
  let at = '';
  let words = '';
  let body: string[] = [];
  const finish = (): void => {
    if (!openEntry) return;
    entries.push({ at, text: cap([body.join('\n').trim(), words].filter(part => part !== '').join('\n')) });
  };
  for (const line of lines) {
    if (line.startsWith('## ')) {
      finish();
      openEntry = true;
      at = '';
      body = [];
      const rest = line.slice(3).replace(/\s*\[leader-network:(?:reply-|digest-)[a-f0-9]{64}\]$/, '');
      const match = HEADING_TIME.exec(rest);
      if (match) {
        at = match[0];
        words = `${rest.slice(0, match.index)} ${rest.slice(match.index + match[0].length)}`.replace(/\s+/g, ' ').trim();
      } else {
        words = rest.trim();
      }
    } else if (openEntry) {
      body.push(line);
    }
    // Lines before the first "## " heading — a "# " title and blank preamble —
    // belong to no entry.
  }
  finish();
  return entries.slice(-Math.floor(limit));
}

/** Read-only tail read of MASON-OUTBOX.md; missing file is 'missing', any read error is 'degraded'. */
export async function readOutboxEntries(opts: { runsDir?: string; limit?: number } = {}): Promise<{ sourceState: 'healthy' | 'missing' | 'degraded'; entries: OutboxEntry[] }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const runsDir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
    handle = await open(join(runsDir, 'leader', 'MASON-OUTBOX.md'), 'r');
    const { size } = await handle.stat();
    const offset = Math.max(0, size - MAX_READ_BYTES);
    const buffer = Buffer.alloc(size - offset);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, offset + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    let markdown = buffer.subarray(0, bytesRead).toString('utf8');
    // An offset inside a line cannot identify a complete heading or body.
    if (offset > 0) {
      const firstNewline = markdown.indexOf('\n');
      markdown = firstNewline < 0 ? '' : markdown.slice(firstNewline + 1);
    }
    return { sourceState: 'healthy', entries: parseOutbox(markdown, opts.limit) };
  } catch (error) {
    const missing = !handle && (error as NodeJS.ErrnoException).code === 'ENOENT';
    return { sourceState: missing ? 'missing' : 'degraded', entries: [] };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

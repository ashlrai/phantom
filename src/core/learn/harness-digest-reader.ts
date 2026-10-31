import { dirname, resolve } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';

const MAX_BYTES = 1024 * 1024;
const DAY_MS = 86_400_000;

type IssueCode = 'malformed_id' | 'duplicate_id' | 'missing_checked' | 'invalid_checked' | 'future_checked' | 'missing_urls';
interface Source {
  id: string;
  title: string;
  checkedAt: string | null;
  urls: string[];
  stale: boolean | null;
}
export interface HarnessDigest {
  v: 1;
  sources: Source[];
  issues: { id: string; code: IssueCode }[];
}

/** Parse data only; neither Markdown nor the cited URLs are executed or fetched. */
export function parseHarnessDigest(markdown: string, now: Date, staleDays = 7): HarnessDigest {
  const result: HarnessDigest = { v: 1, sources: [], issues: [] };
  const seen = new Set<string>();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let source: Source | null = null;
  let checked: string | null = null;
  let hasChecked = false;

  const finish = (): void => {
    if (!source) return;
    const id = source.id;
    if (!hasChecked) result.issues.push({ id, code: 'missing_checked' });
    else {
      const date = checked && /^\d{4}-\d{2}-\d{2}$/.test(checked) ? Date.parse(`${checked}T00:00:00Z`) : NaN;
      if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== checked) {
        result.issues.push({ id, code: 'invalid_checked' });
      } else if (date > today) result.issues.push({ id, code: 'future_checked' });
      else {
        source.checkedAt = checked;
        source.stale = today - date > staleDays * DAY_MS;
      }
    }
    if (source.urls.length === 0) result.issues.push({ id, code: 'missing_urls' });
    result.sources.push(source);
    source = null;
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (/^##(?:\s|$)/.test(line)) {
      finish();
      const candidate = /^##\s+(S\S*)(?:\s+—(?:\s+(.*))?|\s*)$/.exec(line);
      if (!candidate) continue;
      const id = candidate[1]!;
      const title = candidate[2]?.trim() ?? '';
      if (!/^S\d+$/.test(id) || !title) {
        result.issues.push({ id, code: 'malformed_id' });
        continue;
      }
      if (seen.has(id)) result.issues.push({ id, code: 'duplicate_id' });
      seen.add(id);
      source = { id, title, checkedAt: null, urls: [], stale: null };
      checked = null;
      hasChecked = false;
    } else if (source) {
      const dateField = /^- Checked:\s*(.*?)\s*$/.exec(line);
      if (dateField && !hasChecked) {
        hasChecked = true;
        checked = /^(\d{4}-\d{2}-\d{2})\.(?:\s|$)/.exec(dateField[1]!)?.[1] ?? null;
      }
      if (/^- Source:\s*/.test(line)) {
        for (const match of line.matchAll(/\[[^\]]+\]\((https:\/\/[^\s)]+)\)/g)) {
          const url = match[1]!;
          try {
            if (new URL(url).protocol === 'https:' && !source.urls.includes(url)) source.urls.push(url);
          } catch { /* Ignore invalid links. */ }
        }
      }
    }
  }
  finish();
  return result;
}

/** Read a bounded, stable regular file. Failure details never contain a path. */
export function readHarnessDigest(file: string, now: Date, staleDays = 7): HarnessDigest | null {
  const absolute = resolve(file);
  const read = readStableRegularFile(absolute, { anchorPath: dirname(absolute), maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
  return read.ok ? parseHarnessDigest(read.text, now, staleDays) : null;
}

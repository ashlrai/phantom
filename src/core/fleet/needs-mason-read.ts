/**
 * src/core/fleet/needs-mason-read.ts — bounded reader for NEEDS-MASON.md, the
 * file the Mac bridge (scripts/mac-bridge/app_control.py record_permission,
 * safari_import.py note_block) appends when a step only Mason can do, e.g.
 * `- [ ] safari-import[keychain]: Approve the one-time Keychain prompt.`
 *
 * The desktop app's Needs-you list surfaces each open line as a row, so Mason
 * finds out without opening the file by hand. Read-only: nothing here writes
 * or edits the file. Secret-shaped text is scrubbed before it leaves.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';

const FILE_NAME = 'NEEDS-MASON.md';
const MAX_BYTES = 32 * 1024;
const MAX_ITEMS = 20;
const MAX_CHARS = 160;

export interface NeedsMasonItem {
  /** sha1 of the cleaned text, first 12 hex — stable across reloads. */
  id: string;
  text: string;
}

export interface NeedsMasonRead {
  v: 1;
  /** 'absent': no file yet; 'unreadable': link, non-file, oversized or failed read. */
  state: 'absent' | 'ok' | 'unreadable';
  items: NeedsMasonItem[];
}

const CHECKED = /^\s*[-*]?\s*\[[xX]\]/;
const MARKERS = /^(?:[-*]\s*)?(?:\[\s?\]\s*)?/;
const RESOLVED = /resolved/i;

/** Control characters become spaces before whitespace collapse. */
function withoutControl(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out;
}

/** Pure parse so tests never touch the filesystem. Open lines only. */
export function parseNeedsMason(text: string): NeedsMasonItem[] {
  const items: NeedsMasonItem[] = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    if (CHECKED.test(raw)) continue;
    let line = withoutControl(raw).replace(/\s+/g, ' ').trim();
    if (!line || line.startsWith('#') || RESOLVED.test(line)) continue;
    line = line.replace(MARKERS, '').trim();
    if (!line || line.startsWith('#')) continue;
    line = line.slice(0, MAX_CHARS);
    if (seen.has(line)) continue;
    seen.add(line);
    items.push({ id: createHash('sha1').update(line).digest('hex').slice(0, 12), text: line });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/** ASHLR_RUNS_DIR overrides ~/.ashlr-runs — the fleet runs-dir convention. */
export async function readNeedsMason(opts: { runsDir?: string } = {}): Promise<NeedsMasonRead> {
  const runsDir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(join(runsDir, FILE_NAME), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return { v: 1, state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable', items: [] };
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_BYTES) return { v: 1, state: 'unreadable', items: [] };
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    return { v: 1, state: 'ok', items: parseNeedsMason(scrubSecrets(bytes.subarray(0, offset).toString('utf8'))) };
  } catch {
    return { v: 1, state: 'unreadable', items: [] };
  } finally {
    await file.close();
  }
}

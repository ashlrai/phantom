import { execFile } from 'node:child_process';

import { MAX_READ_BYTES } from './scan.js';

export const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const BUFFER_LIMIT = 32 * 1024 * 1024;
const BLOB_BATCH = 128;

export function mapGit(repo: string, args: readonly string[], input?: string): Promise<Buffer> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' });
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['--no-replace-objects', '-c', 'protocol.allow=never', '-C', repo, ...args],
      { encoding: 'buffer', env, timeout: 20_000, maxBuffer: BUFFER_LIMIT, windowsHide: true },
      (error, stdout) => error ? reject(new Error('System map could not read the local Git objects.')) : resolve(stdout));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}

const regular = (mode: string) => mode === '100644' || mode === '100755';

export async function mapTree(repo: string, commit: string): Promise<Array<[string, string]>> {
  const raw = await mapGit(repo, ['ls-tree', '-rz', '--full-tree', commit]);
  return raw.toString('utf8').split('\0').filter(Boolean).flatMap(record => {
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    if (tab < 0 || !mode || !oid || !objectId.test(oid)) throw new Error('Invalid system map tree.');
    return regular(mode) && type === 'blob' ? [[record.slice(tab + 1), oid]] : [];
  });
}

export async function mapDiff(repo: string, before: string, after: string): Promise<Array<[string, string | null]>> {
  const raw = await mapGit(repo, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff',
    '--no-textconv', '--ignore-submodules=none', before, after, '--']);
  const fields = raw.toString('utf8').split('\0');
  const changes: Array<[string, string | null]> = [];
  for (let i = 0; i < fields.length - 1; i += 2) {
    const [, mode, , oid, status] = fields[i]!.split(' ');
    const file = fields[i + 1];
    if (!mode || !oid || !objectId.test(oid) || !file || !/^[ADMT]$/.test(status ?? '')) {
      throw new Error('Invalid system map diff.');
    }
    changes.push([file, regular(mode) && status !== 'D' ? oid : null]);
  }
  return changes;
}

export async function mapBlobs(
  repo: string, ids: readonly string[], visit: (oid: string, source: string | null) => void,
): Promise<void> {
  for (let i = 0; i < ids.length; i += BLOB_BATCH) {
    const chunk = ids.slice(i, i + BLOB_BATCH);
    const headers = (await mapGit(repo, ['cat-file', '--batch-check'], chunk.join('\n') + '\n')).toString('utf8').split('\n');
    const readable = chunk.filter((oid, j) => {
      const [actual, type, size] = (headers[j] ?? '').split(' ');
      if (oid !== actual || type !== 'blob' || !/^\d+$/.test(size ?? '')) throw new Error('System map blob unavailable.');
      if (Number(size) < MAX_READ_BYTES) return true;
      visit(oid, null);
      return false;
    });
    if (!readable.length) continue;
    const raw = await mapGit(repo, ['cat-file', '--batch'], readable.join('\n') + '\n');
    let offset = 0;
    for (const oid of readable) {
      const newline = raw.indexOf(10, offset);
      const [actual, type, sizeText] = raw.toString('ascii', offset, newline).split(' ');
      const size = Number(sizeText);
      const end = newline + 1 + size;
      if (newline < 0 || actual !== oid || type !== 'blob' || !Number.isSafeInteger(size) ||
          size < 0 || size >= MAX_READ_BYTES || raw[end] !== 10) throw new Error('Invalid system map blob.');
      const body = raw.subarray(newline + 1, end);
      const source = body.toString('utf8');
      visit(oid, body.includes(0) || source.includes('\ufffd') ? null : source);
      offset = end + 1;
    }
  }
}

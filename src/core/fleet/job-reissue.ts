import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { DROP_JOB_ID, DROP_JOB_MAX_FILE_BYTES, DropJobExistsError, dropJobExists, resolveDropJobRoot, writeDropJob } from './drop-job-writer.js';

export function nextReissueId(id: string, exists: (candidate: string) => boolean): string {
  const original = id.replace(/^RQ-PHX-/, '');
  if (!DROP_JOB_ID.test(original)) throw new Error('Invalid job id');
  const stem = original.replace(/R\d+$/, '') || 'JOB';
  for (let n = 1; ; n++) {
    const suffix = `R${n}`;
    const candidate = `${stem.slice(0, 40 - suffix.length)}${suffix}`.padStart(3, 'X');
    if (!exists(candidate)) return candidate;
  }
}

export interface ReissueOptions { runsDir: string; lane?: string; tier?: string; now?: () => Date }
export interface ReissueResult {
  outcome: 'written' | 'refused'; id: string; newId: string | null; file: string | null; reason?: string;
}

export async function reissueJob(id: string, opts: ReissueOptions): Promise<ReissueResult> {
  let newId: string | null = null;
  const refused = (reason: string): ReissueResult => ({ outcome: 'refused', id, newId, file: null, reason });
  if (!/^RQ-PHX-[A-Z0-9]{3,40}$/.test(id)) return refused('Invalid job id');
  try {
    const root = resolveDropJobRoot(opts.runsDir);
    const base = await realpath(root);
    const promptPath = await realpath(join(root, `${id}.prompt`));
    if (!promptPath.startsWith(`${base}${sep}`)) return refused('Prompt escapes runs directory');
    const handle = await open(promptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let prompt: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > DROP_JOB_MAX_FILE_BYTES) return refused('Prompt missing, not a file or too large');
      const bytes = Buffer.alloc(DROP_JOB_MAX_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > DROP_JOB_MAX_FILE_BYTES) return refused('Prompt too large');
      prompt = bytes.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
    const header = /^#job repo=phantom lane=(\S+) tier=(\S+)\r?\n/.exec(prompt);
    if (prompt.startsWith('#job') && !header) return refused('Invalid job header');
    let lane = header?.[1] ?? opts.lane ?? '';
    const tier = header?.[2] ?? 'mid';
    let body = header ? prompt.slice(header[0].length).replace(/^\n/, '') : prompt;
    body = body.replace(/\n$/, ''); // The writer supplies the final newline.
    if (lane === 'claude') {
      const value = await readFile(join(root, 'claude-lane.state'), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      const text = value?.trim() ? value : null;
      const down = /^down/i.test(text ?? '');
      if (down) lane = 'codex-personal';
    }
    // Check all locations the ingest tracks; the writer arbitrates concurrent publishes.
    const used = new Set<string>();
    for (;;) {
      newId = nextReissueId(id, candidate => used.has(candidate));
      if (await dropJobExists(root, newId)) { used.add(newId); continue; }
      // Refuse an audit path redirected outside the runs root before publishing.
      const queue = join(root, 'queue');
      const queueReal = await realpath(queue).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return join(base, 'queue');
        throw error;
      });
      if (queueReal !== join(base, 'queue')) return refused('Unsafe audit directory');
      const audit = join(queue, 'job-reissues.jsonl');
      const auditHandle = await open(audit, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
        .catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          await mkdir(queue, { recursive: true });
          return open(audit, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        });
      try {
        let written;
        try { written = await writeDropJob(root, { id: newId, lane, tier, body }, opts.now); }
        catch (error) { if (error instanceof DropJobExistsError) { used.add(newId); continue; } throw error; }
        try { await auditHandle.writeFile(`${JSON.stringify({ at: written.at, from: id, to: newId, lane, tier, file: written.file })}\n`); }
        catch { return { outcome: 'written', id, newId, file: written.file, reason: 'Job queued; audit append failed' }; }
        return { outcome: 'written', id, newId, file: written.file };
      } finally { await auditHandle.close(); }
    }
  } catch { return refused('Prompt unavailable or drop writer refused the job'); }
}

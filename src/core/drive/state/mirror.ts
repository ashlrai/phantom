import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { devNull } from 'node:os';
import { mergeState, parseState, serializeState, type StateSnapshot } from './schema.js';

export interface StateMirror {
  read(): Promise<{ revision: string | null; snapshot: StateSnapshot }>;
  compareAndSwap(revision: string | null, snapshot: StateSnapshot): Promise<boolean>;
}
const REF = 'refs/drive/state-v1';
const EMPTY: StateSnapshot = { schema: 'drive-state.v1', records: [] };

/** A caller-provisioned local bare repo, never a source checkout or network remote. */
export class GitStateMirror implements StateMirror {
  constructor(private readonly directory: string) {
    if (!isAbsolute(directory)) throw new Error('State mirror requires an absolute local path');
  }
  private git(args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile('git', ['-c', `core.hooksPath=${devNull}`, '--git-dir', this.directory, ...args], {
        // Do not inherit credentials, Git overrides, author identities or config.
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' },
        encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
      }, (error, stdout) => {
        if (error) reject(new Error('Drive state Git operation failed'));
        else resolve(stdout.trim());
      });
      child.stdin?.on('error', () => { /* execFile reports process failure */ });
      child.stdin?.end(input);
    });
  }
  private async check(): Promise<void> {
    if (await this.git(['rev-parse', '--is-bare-repository']) !== 'true') throw new Error('State mirror must be a bare repository');
  }
  async read(): Promise<{ revision: string | null; snapshot: StateSnapshot }> {
    await this.check();
    const refs = await this.git(['for-each-ref', '--format=%(objectname)', REF]);
    if (!refs) return { revision: null, snapshot: { ...EMPTY, records: [] } };
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(refs)) throw new Error('Invalid state mirror revision');
    return { revision: refs, snapshot: parseState(await this.git(['cat-file', 'blob', refs])) };
  }
  async compareAndSwap(revision: string | null, snapshot: StateSnapshot): Promise<boolean> {
    const serialized = serializeState(snapshot);
    if (revision !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new Error('Invalid state mirror revision');
    await this.check();
    const oid = await this.git(['hash-object', '-w', '--stdin'], serialized);
    try {
      await this.git(['update-ref', REF, oid, revision ?? '0'.repeat(oid.length)]);
      return true;
    } catch {
      // Only a changed head is a contention retry; other failures remain errors.
      if ((await this.read()).revision !== revision) return false;
      throw new Error('Drive state mirror update failed');
    }
  }
}
/** Merge each fresh head before CAS; a concurrent writer can never lose records. */
export async function replicateState(mirror: StateMirror, local: StateSnapshot): Promise<StateSnapshot> {
  const safe = parseState(serializeState(local));
  for (let attempt = 0; attempt < 16; attempt++) {
    const remote = await mirror.read();
    const merged = mergeState(remote.snapshot, safe);
    if (serializeState(merged) === serializeState(remote.snapshot)) return merged;
    if (await mirror.compareAndSwap(remote.revision, merged)) return merged;
  }
  throw new Error('Drive state mirror contention limit reached');
}

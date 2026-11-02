import { closeSync, constants, lstatSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { cmdFleetGuardianDrain } from './fleet-guardian-drain.js';

type Drain = typeof cmdFleetGuardianDrain;
type DrainDeps = NonNullable<Parameters<Drain>[1]>;
export interface GuardianRecordDependencies {
  drain?: Drain;
  drainDeps?: Omit<DrainDeps, 'writeLine'>;
  output?: (line: string) => void | Promise<void>;
  rename?: typeof renameSync;
}

// Same bound guardian-continue applies to its stdin summary; a larger file
// would be refused there, so it is refused here before anything is replaced.
const LIMIT = 32 * 1024;
const DRAIN_PATH_FLAGS = new Set(['--manifest', '--source-state', '--output-dir', '--stop-file']);

// `fleet guardian-record` — run `guardian-drain` with streaming forced on,
// relay its NDJSON live, and persist only its final sanitized summary to a
// private --result-file for guardian-continue to read later. Attempt records
// are never retained. A distinguishable `record: "receipt"` line follows the
// drain. The drain exit code is preserved; a persistence failure returns
// nonzero even when the drain succeeded. Preview summaries may be saved, but
// guardian-continue refuses any summary whose mode is not 'apply'.
export async function cmdFleetGuardianRecord(args: string[], deps: GuardianRecordDependencies = {}): Promise<number> {
  const emit = deps.output ?? writeStdoutLine;
  const receipt = async (persisted: boolean, reason: string): Promise<void> => {
    await emit(`${JSON.stringify({ record: 'receipt', v: 1, persisted, reason })}\n`);
  };
  let path: string | undefined;
  const forwarded: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--result-file') {
      const value = args[++i];
      if (path !== undefined || !value || !isAbsolute(value) || resolve(value) !== value || value === parse(value).root) {
        await receipt(false, 'invalid arguments'); return 2;
      }
      path = value;
    } else if (arg === '--json' || arg === '--stream') {
      await receipt(false, 'invalid arguments'); return 2;
    } else forwarded.push(arg);
  }
  if (!path) { await receipt(false, 'invalid arguments'); return 2; }
  // The result file must not name a drain input or output: the rename would replace it.
  const drainPaths = forwarded.flatMap((arg, i) => DRAIN_PATH_FLAGS.has(arg) ? [forwarded[i + 1]] : []);
  if (drainPaths.includes(path)) { await receipt(false, 'duplicate result path'); return 2; }
  try { checkPath(path); } catch { await receipt(false, 'unsafe destination'); return 1; }

  const summaries: string[] = [];
  const writeLine = async (line: string): Promise<void> => {
    if (recordOf(line)?.['record'] === 'summary') summaries.push(line);
    await emit(line);
  };
  let code: number;
  try {
    code = await (deps.drain ?? cmdFleetGuardianDrain)([...forwarded, '--stream'], { ...deps.drainDeps, writeLine });
  } catch { await receipt(false, 'delegate failed'); return 1; }
  const saved = persist(path, summaries, deps.rename ?? renameSync);
  await receipt(saved.persisted, saved.reason);
  return saved.persisted ? code : code || 1;
}

// Mirrors fleet-self-loop-record: every ancestor must be a real directory owned
// by the user or root, and a root-owned sticky directory (such as /tmp) is allowed.
function checkPath(path: string): void {
  const parent = dirname(path);
  if (realpathSync(parent) !== parent) throw new Error('unsafe parent');
  let dir = parent;
  const uid = process.getuid?.();
  for (;;) {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || (uid !== undefined && st.uid !== uid && st.uid !== 0)
      || ((st.mode & 0o022) !== 0 && !(st.uid === 0 && (st.mode & 0o1000) !== 0))) throw new Error('unsafe parent');
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || (uid !== undefined && st.uid !== uid) || st.nlink !== 1) throw new Error('unsafe target');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

// Exactly one summary, bounded, and shaped like a drain summary, or the prior file stays untouched.
function persist(path: string, summaries: string[], rename: typeof renameSync): { persisted: boolean; reason: string } {
  if (summaries.length !== 1) return { persisted: false, reason: 'invalid summary' };
  const line = summaries[0]!;
  if (Buffer.byteLength(line, 'utf8') > LIMIT) return { persisted: false, reason: 'summary too large' };
  const s = recordOf(line);
  if (!s || (s['mode'] !== 'preview' && s['mode'] !== 'apply') || typeof s['termination'] !== 'string'
    || typeof s['attempts'] !== 'number' || !Number.isSafeInteger(s['attempts'])) return { persisted: false, reason: 'invalid summary' };
  let temp: string | undefined;
  try {
    checkPath(path);
    temp = join(dirname(path), `.guardian-record-${randomBytes(16).toString('hex')}.tmp`);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, line, 'utf8'); } finally { closeSync(fd); }
    checkPath(path);
    rename(temp, path);
    temp = undefined;
    return { persisted: true, reason: 'completed' };
  } catch {
    if (temp) { try { unlinkSync(temp); } catch { /* best effort */ } }
    return { persisted: false, reason: 'persistence failed' };
  }
}

function recordOf(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function writeStdoutLine(line: string): Promise<void> {
  return new Promise<void>((done, fail) => {
    process.stdout.write(line, error => (error ? fail(error) : done()));
  });
}

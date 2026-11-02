import { constants, lstatSync, openSync, closeSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { cmdFleetSelfLoop } from './fleet-self-loop.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

type Loop = typeof cmdFleetSelfLoop;
interface Dependencies {
  loop?: Loop;
  output?: (text: string) => void;
  now?: () => number;
  loopDeps?: NonNullable<Parameters<Loop>[1]>;
  rename?: typeof renameSync;
}
const MAX_BYTES = 64 * 1024;

// All ancestors must be real directories controlled by the user or root. A
// root-owned sticky directory (such as /tmp) may be shared safely.
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

function isSummary(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  return s['v'] === 1 && typeof s['startedAt'] === 'string' && Number.isFinite(Date.parse(s['startedAt']))
    && typeof s['endedAt'] === 'string' && Number.isFinite(Date.parse(s['endedAt']))
    && count(s['elapsedMs']) && count(s['durationMs']) && (s['durationMs'] as number) > 0
    && count(s['intervalMs']) && (s['intervalMs'] as number) > 0
    && count(s['ticks']) && (s['ticks'] as number) > 0 && count(s['failures']) && count(s['busy'])
    && (s['failures'] as number) <= (s['ticks'] as number) && (s['busy'] as number) <= (s['ticks'] as number)
    && ['duration', 'interrupted', 'observer-error'].includes(s['termination'] as string)
    && Object.hasOwn(s, 'lastReport');
}

export async function cmdFleetSelfLoopRecord(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const receipt = (persisted: boolean, reason: string) => output(JSON.stringify({ v: 1, persisted, reason }));
  let path: string | undefined;
  const forwarded: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--result-file') {
      const value = args[++i];
      if (path !== undefined || !value || !isAbsolute(value) || resolve(value) !== value || value === parse(value).root) {
        receipt(false, 'invalid arguments'); return 2;
      }
      path = value;
    } else if (arg === '--json' || arg === '--stream') {
      receipt(false, 'invalid arguments'); return 2;
    } else forwarded.push(arg);
  }
  if (!path) { receipt(false, 'invalid arguments'); return 2; }
  try { checkPath(path); } catch { receipt(false, 'unsafe destination'); return 1; }
  const now = deps.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  let captured = '', calls = 0, oversized = false, code: number;
  try {
    code = await (deps.loop ?? cmdFleetSelfLoop)([...forwarded, '--json'], {
      ...deps.loopDeps,
      output: (text) => {
        calls++;
        if (Buffer.byteLength(text, 'utf8') > MAX_BYTES || calls > 1) { oversized = true; return; }
        captured = text;
      },
      error: () => {},
    });
  } catch { receipt(false, 'delegate failed'); return 1; }
  const finishedAt = new Date(now()).toISOString();
  let summary: unknown;
  try { summary = JSON.parse(captured); } catch { receipt(false, 'invalid summary'); return code || 1; }
  if (oversized || calls !== 1 || !isSummary(summary)) { receipt(false, 'invalid summary'); return code || 1; }
  const record = JSON.stringify(sanitizePublicJson({ v: 1, startedAt, finishedAt, summary })) + '\n';
  if (Buffer.byteLength(record, 'utf8') > MAX_BYTES) { receipt(false, 'summary too large'); return code || 1; }
  let temp: string | undefined;
  try {
    checkPath(path);
    temp = join(dirname(path), `.self-loop-record-${randomBytes(16).toString('hex')}.tmp`);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, record, 'utf8'); } finally { closeSync(fd); }
    checkPath(path);
    (deps.rename ?? renameSync)(temp, path);
    temp = undefined;
  } catch {
    if (temp) { try { unlinkSync(temp); } catch { /* best effort */ } }
    receipt(false, 'persistence failed'); return code || 1;
  }
  receipt(true, 'completed');
  return code;
}

/** Synthetic-only runtime compatibility proof. It is not repository/merge authority. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { CORTEX_CODEX_PERMISSION_CONFIG, CORTEX_CODEX_PERMISSION_PROFILE, CORTEX_CODEX_RESTRICTED_ARGS } from './codex-policy.js';

const MAX_EXECUTABLE_BYTES = 512n * 1024n * 1024n;
const DEADLINE_MS = 12_000;
const EXPECTED = { inside: true, scratch: true, siblingDenied: true, unrelatedTmpDenied: true, aliasDenied: true, privateReadDenied: true, networkDenied: true };
const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const policyDigest = (): string => digest(JSON.stringify([CORTEX_CODEX_PERMISSION_CONFIG, CORTEX_CODEX_RESTRICTED_ARGS]));
function demand(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Cortex Codex runtime unsupported: ${reason}. Select and explicitly qualify a compatible executable; no automatic fallback is allowed.`);
}
type ExecutablePin = { requested: string; path: string; dev: bigint; ino: bigint; size: bigint; mtime: bigint; ctime: bigint; sha256: string };

function executablePin(requested: string): ExecutablePin {
  demand(isAbsolute(requested), 'the selected executable must be an absolute path');
  const path = realpathSync(requested);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    demand(before.isFile() && before.size > 0n && before.size <= MAX_EXECUTABLE_BYTES && (before.mode & 0o111n) !== 0n && (before.mode & 0o022n) === 0n,
      'selected executable must be a bounded executable regular file without group/world write permission');
    const sha256 = digest(readFileSync(fd));
    const after = fstatSync(fd, { bigint: true }); const named = lstatSync(path, { bigint: true });
    demand(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs &&
      after.dev === named.dev && after.ino === named.ino && after.size === named.size && after.mtimeNs === named.mtimeNs && after.ctimeNs === named.ctimeNs &&
      !named.isSymbolicLink() && realpathSync(requested) === path, 'executable changed while being pinned');
    return { requested, path, dev: before.dev, ino: before.ino, size: before.size, mtime: before.mtimeNs, ctime: before.ctimeNs, sha256 };
  } finally { closeSync(fd); }
}
function sameExecutable(pin: ExecutablePin, content: boolean): boolean {
  try {
    if (realpathSync(pin.requested) !== pin.path || realpathSync(pin.path) !== pin.path) return false;
    const now = lstatSync(pin.path, { bigint: true });
    if (!now.isFile() || now.isSymbolicLink() || now.dev !== pin.dev || now.ino !== pin.ino || now.size !== pin.size || now.mtimeNs !== pin.mtime || now.ctimeNs !== pin.ctime) return false;
    return !content || executablePin(pin.requested).sha256 === pin.sha256;
  } catch { return false; }
}
type FixturePin = { path: string; dev: bigint; ino: bigint };
function fixture(parent: string): FixturePin {
  const path = realpathSync(mkdtempSync(join(parent, 'cortex-codex-proof-')));
  const st = lstatSync(path, { bigint: true });
  demand(st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o7777n) === 0o700n &&
    (process.getuid === undefined || st.uid === BigInt(process.getuid())), 'fixture is not private and owned');
  return { path, dev: st.dev, ino: st.ino };
}
function removeFixture(pin: FixturePin): void {
  const st = lstatSync(pin.path, { bigint: true });
  demand(st.isDirectory() && !st.isSymbolicLink() && st.dev === pin.dev && st.ino === pin.ino && realpathSync(pin.path) === pin.path &&
    (st.mode & 0o7777n) === 0o700n && (process.getuid === undefined || st.uid === BigInt(process.getuid())),
    'fixture identity changed; retained for operator inspection');
  rmSync(pin.path, { recursive: true, force: true });
}

// The only guest input is this self-created fixture. No company path, prompt,
// credential, caller config or environment value is passed into its process.
const PROBE = String.raw`
workspace=$1; scratch=$2; sibling=$3; unrelated=$4; alias=$5; private_read=$6; marker=$7; port=$8
allowed() { if { printf '%s' "$marker" > "$1"; } 2>"$workspace/denial.log"; then printf true; else printf false; fi; }
denied() {
  if { printf '%s' "$marker" > "$1"; } 2>"$workspace/denial.log"; then printf false
  elif /usr/bin/grep -Eqi 'operation not permitted|permission denied' "$workspace/denial.log"; then printf true; else printf false; fi
}
inside=$(allowed "$workspace/inside"); scratch_ok=$(allowed "$scratch")
sibling_denied=$(denied "$sibling"); unrelated_denied=$(denied "$unrelated"); alias_denied=$(denied "$alias")
private_denied=false
if /bin/cat "$private_read" > /dev/null 2>"$workspace/denial.log"; then private_denied=false
elif /usr/bin/grep -Eqi 'operation not permitted|permission denied' "$workspace/denial.log"; then private_denied=true; fi
network_denied=false
if /usr/bin/nc -w 1 -z -v 127.0.0.1 "$port" 2>"$workspace/network.log"; then network_denied=false
elif /usr/bin/grep -Eqi 'operation not permitted|permission denied' "$workspace/network.log"; then network_denied=true; fi
printf '{"inside":%s,"scratch":%s,"siblingDenied":%s,"unrelatedTmpDenied":%s,"aliasDenied":%s,"privateReadDenied":%s,"networkDenied":%s}\n' "$inside" "$scratch_ok" "$sibling_denied" "$unrelated_denied" "$alias_denied" "$private_denied" "$network_denied"
`;

/** No cross-contact success cache: a new synthetic proof is required every time. */
export async function withCortexCodexRuntime<T>(requested: string,
  context: { signal?: AbortSignal; assertCurrent: () => void },
  contact: (executable: string, current: () => boolean, signal: AbortSignal) => Promise<T>): Promise<T> {
  demand(process.platform !== 'win32', 'native foreground admission requires POSIX confinement');
  const started = Date.now(); let active = true; let qualifying = true; const policy = policyDigest();
  const controller = new AbortController();
  const signal = AbortSignal.any(context.signal ? [context.signal, controller.signal] : [controller.signal]);
  context.assertCurrent(); demand(!context.signal?.aborted, 'execution was cancelled');
  const pin = executablePin(requested);
  const gate = (content = false): void => {
    if (signal.aborted && signal.reason instanceof Error) throw signal.reason;
    demand(active && !signal.aborted, 'execution was cancelled or its contact scope closed');
    if (qualifying) demand(Date.now() - started < DEADLINE_MS, 'synthetic proof exceeded its deadline');
    context.assertCurrent(); demand(policyDigest() === policy, 'permission policy changed');
    demand(sameExecutable(pin, content), 'selected executable identity or content changed');
    context.assertCurrent(); demand(!signal.aborted, 'execution was cancelled');
    demand(policyDigest() === policy && sameExecutable(pin, false), 'selected executable or permission policy changed before use');
  };
  const root = fixture(tmpdir()); let other: FixturePin | undefined;
  const server = createServer(socket => { connected = true; socket.destroy(); }); let connected = false;
  let child: ReturnType<typeof spawn> | undefined; let timer: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let childUncertain = false;
  const terminate = (): void => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already stopped */ } }
  };
  try {
    other = fixture(realpathSync('/tmp'));
    const workspace = join(root.path, 'workspace'); const scratch = join(root.path, 'scratch'); const nativeHome = join(root.path, 'native-home');
    for (const path of [workspace, scratch, nativeHome, join(root.path, 'sibling')]) mkdirSync(path, { mode: 0o700 });
    const marker = randomUUID(); const privateRead = join(root.path, 'private-marker'); writeFileSync(privateRead, marker, { mode: 0o600 });
    symlinkSync(join(root.path, 'sibling'), join(workspace, 'escape'));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); demand(address && typeof address !== 'string', 'loopback fixture could not bind');
    const spec = { marker, port: address.port, inside: join(workspace, 'inside'), scratch: join(scratch, 'inside'),
      sibling: join(root.path, 'sibling', 'outside'), unrelated: join(other.path, 'outside'),
      alias: join(workspace, 'escape', 'alias-outside'), privateRead };
    gate(true);
    const output = await new Promise<string>((resolve, reject) => {
      let stdout = ''; let stderr = ''; let failure: Error | undefined; let settled = false;
      let drain: ReturnType<typeof setTimeout> | undefined; let stopDeadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (code: number | null): void => {
        if (settled) return; settled = true; if (drain) clearTimeout(drain); if (stopDeadline) clearTimeout(stopDeadline);
        signal.removeEventListener('abort', cancelled);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Cortex Codex runtime unsupported: synthetic sandbox refused (${code}); no provider contact allowed`, { cause: stderr }));
        else resolve(stdout);
      };
      const stop = (error: unknown): void => {
        failure ??= error instanceof Error ? error : new Error('Cortex runtime qualification stopped');
        controller.abort(failure); terminate();
        // Fail closed within a bounded interval even if a killed child cannot
        // be reaped. Its exact private fixtures are then retained, never reused.
        stopDeadline ??= setTimeout(() => { child?.stdout?.destroy(); child?.stderr?.destroy(); finish(null); }, 1000);
      };
      const cancelled = (): void => stop(signal.reason ?? new Error('Cortex runtime qualification cancelled'));
      child = spawn(pin.path, ['sandbox', '--permissions-profile', CORTEX_CODEX_PERMISSION_PROFILE, '-C', workspace,
        '-c', CORTEX_CODEX_PERMISSION_CONFIG, '/bin/sh', '-c', PROBE, 'probe', workspace,
        spec.scratch, spec.sibling, spec.unrelated, spec.alias, spec.privateRead, marker, String(spec.port)], {
        cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: nativeHome, CODEX_HOME: nativeHome, TMPDIR: scratch, TMP: scratch, TEMP: scratch, LANG: 'C', LC_ALL: 'C' },
      });
      childUncertain = child.pid !== undefined;
      child.once('error', error => { if (!child?.pid) childUncertain = false; stop(error); finish(null); });
      child.once('exit', code => {
        childUncertain = false;
        // A descendant must not keep qualification alive via inherited pipes.
        drain = setTimeout(() => { terminate(); child?.stdout?.destroy(); child?.stderr?.destroy(); finish(code); }, 250);
      });
      child.once('close', code => { childUncertain = false; finish(code); });
      child.stdout?.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(0, 8193); if (stdout.length > 8192) stop(new Error('Cortex runtime probe exceeded output bound')); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 8193); if (stderr.length > 8192) stop(new Error('Cortex runtime probe exceeded diagnostic bound')); });
      signal.addEventListener('abort', cancelled, { once: true });
      if (signal.aborted) cancelled();
      timer = setInterval(() => { try { gate(); demand(Date.now() - started < DEADLINE_MS, 'synthetic proof exceeded its deadline'); } catch (error) { stop(error); } }, 100);
      deadline = setTimeout(() => stop(new Error('Cortex runtime qualification timed out; no provider contact allowed')), Math.max(1, DEADLINE_MS - (Date.now() - started)));
    });
    clearInterval(timer); timer = undefined; clearTimeout(deadline); deadline = undefined;
    terminate(); child = undefined;
    gate(true);
    demand(JSON.stringify(JSON.parse(output)) === JSON.stringify(EXPECTED) && !connected,
      'native sandbox must allow only workspace/private scratch while denying sibling/alias/unrelated temp reads+writes and loopback');
    demand(readFileSync(spec.inside, 'utf8') === marker && readFileSync(spec.scratch, 'utf8') === marker,
      'synthetic workspace/private scratch effects were not produced');
    for (const path of [spec.sibling, spec.unrelated, join(root.path, 'sibling', 'alias-outside')]) {
      try { lstatSync(path); demand(false, 'an outside fixture was modified'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    gate(true);
    qualifying = false;
    timer = setInterval(() => { try { gate(); } catch (error) { controller.abort(error); } }, 100);
    const result = await contact(pin.path, () => { try { gate(true); return true; } catch { return false; } }, signal);
    gate(true);
    return result;
  } finally {
    active = false; controller.abort(); if (timer) clearInterval(timer); if (deadline) clearTimeout(deadline); terminate();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (!childUncertain) { if (other) removeFixture(other); removeFixture(root); }
  }
}

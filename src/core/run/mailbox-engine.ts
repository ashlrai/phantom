/** One-shot inbox → confined CLI → outbox transport. No scheduling or authority. */
import { constants } from 'node:fs';
import { link, lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AshlrConfig } from '../types.js';
import type { SandboxLauncher } from '../sandbox/confine.js';
import { spawnEngine } from './engines.js';

const MAX_BYTES = 1024 * 1024;

export interface MailboxEngineRequest {
  engine: 'codex' | 'claude';
  /** Existing throwaway worktree. This adapter never creates or authorizes one. */
  sandboxDir: string;
  /** Existing UTF-8 inbox file and absent reply file, both inside sandboxDir. */
  inbox: string;
  outbox: string;
  /** Required OS confinement from the sandbox owner; no raw execution fallback. */
  launcher: SandboxLauncher;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function assertInside(root: string, path: string): void {
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('Mailbox paths must be inside the sandbox');
  }
}

async function readBoundedFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Mailbox input must be a bounded regular file');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_BYTES) throw new Error('Mailbox input exceeds size limit');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } finally {
    await file.close();
  }
}

function replyText(engine: MailboxEngineRequest['engine'], output: string): string {
  if (Buffer.byteLength(output) > MAX_BYTES) throw new Error('Mailbox reply exceeds size limit');
  if (engine === 'claude') {
    const result: unknown = JSON.parse(output);
    if (typeof result === 'object' && result !== null && 'type' in result && result.type === 'result'
      && 'subtype' in result && result.subtype === 'success'
      && !('is_error' in result && result.is_error)
      && 'result' in result && typeof result.result === 'string' && result.result.trim()) return result.result;
  } else {
    let reply: string | undefined;
    let completed = false;
    for (const line of output.split('\n').filter(line => line.trim())) {
      if (completed) throw new Error('Mailbox received events after turn completion');
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === 'error' || event.type === 'turn.failed') throw new Error('Mailbox engine reported failure');
      if (event.type === 'turn.completed') completed = true;
      if (event.type === 'item.completed' && typeof event.item === 'object' && event.item !== null) {
        const item = event.item as Record<string, unknown>;
        if (item.type === 'agent_message' && typeof item.text === 'string') reply = item.text;
      }
    }
    if (completed && reply?.trim()) return reply;
  }
  throw new Error('Mailbox engine did not return a successful final reply');
}

/**
 * Run only inside a caller-owned sandbox and publish a reply atomically without
 * overwriting an existing delivery. Inbox survives failures for caller retry.
 * Prompt content travels on stdin, never shell syntax or process arguments.
 * The caller retains sandbox lifecycle, diff capture and proposal authority.
 */
export async function runMailboxEngine(request: MailboxEngineRequest, cfg: AshlrConfig): Promise<void> {
  if (!request.launcher?.bin || !Array.isArray(request.launcher.prefixArgs)) throw new Error('Mailbox engine requires confinement');
  if (request.engine !== 'codex' && request.engine !== 'claude') throw new Error('Unsupported mailbox engine');
  if (request.signal?.aborted) throw new Error('Mailbox engine cancelled');
  const root = await realpath(request.sandboxDir);
  const inbox = resolve(root, request.inbox);
  const outbox = resolve(root, request.outbox);
  assertInside(root, inbox);
  assertInside(root, outbox);
  assertInside(root, await realpath(inbox));
  assertInside(root, join(await realpath(dirname(outbox)), 'reply'));
  // Canonical parents prevent parent-directory symlinks from redirecting I/O.
  if (await realpath(dirname(inbox)) !== dirname(inbox) || await realpath(dirname(outbox)) !== dirname(outbox)) {
    throw new Error('Mailbox parents must be canonical sandbox directories');
  }
  try {
    await lstat(outbox);
    throw new Error('Mailbox reply already exists');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const prompt = await readBoundedFile(inbox);
  const exchange = await mkdtemp(join(root, '.phantom-mailbox-'));
  try {
    const promptPath = join(exchange, 'prompt.txt');
    await writeFile(promptPath, prompt, { mode: 0o600, flag: 'wx' });
    const args = request.engine === 'codex'
      ? ['exec', '--cd', root, '--json', ...(request.model ? ['--model', request.model] : []), '-']
      : ['-p', '--output-format', 'json', ...(request.model ? ['--model', request.model] : [])];
    const result = await spawnEngine({ bin: request.engine, args, cwd: root }, cfg, {
      launcher: request.launcher,
      stdin: await readBoundedFile(promptPath),
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      nativeEngine: request.engine,
    });
    // Never include vendor stderr/output in transport errors (may contain secrets).
    if (!result.ok || request.signal?.aborted) throw new Error('Mailbox engine failed or was cancelled');
    let reply: string;
    try {
      reply = replyText(request.engine, result.output);
    } catch {
      throw new Error('Mailbox engine did not return a valid successful reply');
    }
    if (await realpath(dirname(outbox)) !== dirname(outbox)) throw new Error('Mailbox output directory changed');
    const staged = join(exchange, 'reply.txt');
    await writeFile(staged, reply, { mode: 0o600, flag: 'wx' });
    if (request.signal?.aborted) throw new Error('Mailbox engine cancelled');
    await link(staged, outbox);
  } finally {
    await rm(exchange, { recursive: true, force: true });
  }
}

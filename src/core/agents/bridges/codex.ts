/** Codex send bridge. The only command is `codex queue --thread <id> --message <text>`. */
import { execFile } from 'node:child_process';
import type { DeliverResult } from '../channel-policy.js';

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const CODEX_MESSAGE_MAX = 16_384;

export interface CommandExec {
  (file: string, args: readonly string[]): Promise<{ code: number }>;
}

export function codexQueueArgs(threadId: string, text: string): readonly string[] {
  return ['queue', '--thread', threadId, '--message', text];
}

export function defaultCodexExec(file: string, args: readonly string[]): Promise<{ code: number }> {
  return new Promise(resolve => {
    execFile(file, [...args], { timeout: 10_000, windowsHide: true, shell: false, maxBuffer: 32 * 1024 }, error => {
      if (!error) { resolve({ code: 0 }); return; }
      const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1;
      resolve({ code });
    });
  });
}

export async function sendCodexBridge(input: { threadId: string; text: string }, exec: CommandExec): Promise<DeliverResult> {
  if (!THREAD_ID.test(input.threadId)) return { status: 'refused', reason: 'Codex thread id is not a safe label.' };
  if (typeof input.text !== 'string' || input.text.trim() === '' || input.text.length > CODEX_MESSAGE_MAX || input.text.includes('\0')) {
    return { status: 'refused', reason: 'Codex message is empty or too long.' };
  }
  try {
    const result = await exec('codex', codexQueueArgs(input.threadId, input.text));
    if (result.code === 0) return { status: 'sent', reason: 'Codex accepted the queued message.' };
    return { status: 'refused', reason: 'Codex did not accept the queued message.' };
  } catch {
    return { status: 'refused', reason: 'Codex send failed closed.' };
  }
}

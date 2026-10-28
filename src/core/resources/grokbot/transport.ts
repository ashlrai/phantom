import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTask, refuse, safeJson, type GrokbotTask } from './contract.js';

/** Only the Secrets-owned child proxy URL is accepted. The upstream webhook URL
 * and authentication stay in Secrets, never in the task, argv, or parent. */
export async function postGrokbotTask(task: GrokbotTask, proxyUrl: string | undefined, now = Date.now()): Promise<void> {
  const payload = safeJson(parseTask(task, now));
  let url: URL;
  try { url = new URL(proxyUrl ?? ''); } catch { refuse('secrets-route-unavailable'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password ||
      url.search || url.hash || !/^\/grokbot\/_phantom\/[A-Za-z0-9_-]+\/$/.test(url.pathname)) refuse('secrets-route-unavailable');
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': task.id }, body: payload,
      signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, Date.parse(task.deadline) - now))) });
    await response.body?.cancel();
    if (response.status !== 202) refuse('webhook-not-accepted');
  } catch { refuse('delivery-uncertain'); }
}

/** No shell, raw credential env, provider stdout or provider stderr is forwarded. */
export function sendViaPhantomExec(task: GrokbotTask, cwd: string): Promise<void> {
  const payload = safeJson(parseTask(task, Date.now()));
  return new Promise((resolve, reject) => {
    const child = spawn('phantom', ['exec', '--', process.execPath,
      fileURLToPath(new URL('./worker.js', import.meta.url))], {
      cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ['pipe', 'ignore', 'ignore'],
      timeout: Math.max(1, Math.min(20_000, Date.parse(task.deadline) - Date.now())), killSignal: 'SIGKILL',
    });
    child.stdin.on('error', () => { /* Exit/error below owns delivery uncertainty. */ });
    child.once('error', () => reject(new Error('grokbot: secrets-exec-unavailable')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error('grokbot: delivery-uncertain')));
    child.stdin.end(payload);
  });
}

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { readEmailOutbox, sendEmailOutbox } from '../src/core/comms/email-outbox.js';
import { awaitEmailOutboxBatch } from '../src/core/comms/email-outbox-batch-await.js';

it('retains an interrupted claim for the batch observer without retrying it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'email-crash-batch-'));
  const outbox = join(root, 'outbox');
  const interrupted = 'a.reply.eml';
  const sibling = 'b.reply.eml';
  const message = 'To: fixture@example.test\nSubject: Synthetic reply\n\nSynthetic test body.\n';
  let child: ChildProcess | undefined;
  try {
    mkdirSync(outbox);
    writeFileSync(join(outbox, interrupted), message, { mode: 0o600 });
    const script = `
      import { sendEmailOutbox } from './src/core/comms/email-outbox.ts';
      await sendEmailOutbox({
        dir: process.argv[1], allowedRecipients: new Set(['fixture@example.test']),
        transport: async () => {
          process.send('claim-ready');
          await new Promise(() => {});
          return { ok: true };
        },
      });
    `;
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, outbox], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: root, TMPDIR: root },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (data: string) => { stderr += data; });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`claim-ready timed out: ${stderr}`)), 10_000);
      child!.once('message', (value) => {
        clearTimeout(timer);
        if (value === 'claim-ready') resolve();
        else reject(new Error('unexpected child message'));
      });
      void exited.then(() => { clearTimeout(timer); reject(new Error(`child exited before claim-ready: ${stderr}`)); }, reject);
    });
    await ready;
    expect(existsSync(join(outbox, 'sending', interrupted))).toBe(true);
    child.kill('SIGKILL');
    expect(await exited).toEqual([null, 'SIGKILL']);

    expect(readEmailOutbox(outbox).entries).toEqual([{ name: interrupted, state: 'stuck', reason: 'interrupted-send' }]);
    const batch = await awaitEmailOutboxBatch({ dir: outbox, names: [interrupted], timeoutMs: 1000, pollMs: 100, signal: new AbortController().signal });
    expect(batch).toEqual({ rows: [{ name: interrupted, state: 'stuck', reason: 'interrupted-send' }], timedOut: false, cancelled: false, sourceFailure: false });

    writeFileSync(join(outbox, sibling), message, { mode: 0o600 });
    const calls: string[] = [];
    const pass = await sendEmailOutbox({ dir: outbox, allowedRecipients: new Set(['fixture@example.test']), transport: async (mail) => {
      calls.push(mail.body);
      return { ok: true };
    } });
    expect(calls).toEqual(['Synthetic test body.\n']);
    expect(pass).toMatchObject({ sent: 1, stuck: 1, queued: 0, drafted: 0, failed: 0, refused: 0 });
    expect(pass.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: interrupted, outcome: 'stuck', reason: 'interrupted-send' }),
      expect.objectContaining({ name: sibling, outcome: 'sent' }),
    ]));
    expect(readFileSync(join(outbox, 'sending', interrupted), 'utf8')).toBe(message);
    expect(readFileSync(join(outbox, 'sent', sibling), 'utf8')).toBe(message);
    expect(existsSync(join(outbox, interrupted))).toBe(false);
    expect(existsSync(join(outbox, 'sent', interrupted))).toBe(false);
    expect(readEmailOutbox(outbox).counts).toEqual({ queued: 0, sent: 1, stuck: 1, drafted: 0 });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

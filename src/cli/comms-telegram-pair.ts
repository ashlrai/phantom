/** Explicit local operator enrollment; never polls, sends, or impersonates a Telegram event. */
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfigReadOnlyStrict } from '../core/config.js';
import { telegramEnabled, telegramQuestionNamespace } from '../core/integrations/telegram.js';
import { initializeOperatorSecret, readOperatorSecret } from '../core/fleet/operator-proof.js';
import { acceptTelegramPair } from '../core/fleet/operator-glance-read.js';
import { ensurePrivateDirectory } from '../core/verse/preferences.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';

const usage = 'usage: phm comms pair-telegram [--json]';
export async function cmdPairTelegram(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  const json = args.length === 1 && args[0] === '--json';
  if (args.length && !json) { console.error(usage); return 2; }
  const done = (ok: boolean, reason: string, secretCreated = false) => {
    const result = { ok, reason, secretCreated };
    console.log(json ? JSON.stringify(result) : ok ? 'Configured Telegram operator paired.' : `Telegram pairing refused: ${reason}.`);
    return ok ? 0 : 1;
  };
  try {
    const cfg = loadConfigReadOnlyStrict();
    const raw = cfg.comms?.telegram?.chatId;
    const id = typeof raw === 'string' && /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
    if (!telegramEnabled(cfg) || !Number.isSafeInteger(id) || id <= 0) return done(false, 'configured-private-owner-required');
    const binding = telegramQuestionNamespace(cfg);
    if (!binding) return done(false, 'configured-private-owner-required');
    if (process.platform === 'win32' && readOperatorSecret().state !== 'ready') return done(false, 'operator-secret-initialization-unsupported');
    const runs = join(homedir(), '.ashlr-runs');
    const queue = join(runs, 'queue');
    ensurePrivateDirectory(runs); ensurePrivateDirectory(queue);
    for (const directory of [runs, queue]) {
      if ((lstatSync(directory).mode & 0o022) !== 0) return done(false, 'unsafe-pairing-directory');
    }
    // Refuse an unsafe/foreign existing record BEFORE initializing any secret.
    const pair = join(queue, 'telegram-pair.json');
    try {
      const stat = lstatSync(pair);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== lstatSync(queue).uid || (stat.mode & 0o777) !== 0o600
        || stat.size > 256) return done(false, 'existing-pair-unavailable');
      const read = readStableRegularFile(pair, { anchorPath: queue, maxFileBytes: 256, remainingBytes: 256 });
      if (!read.ok) return done(false, 'existing-pair-unavailable');
      const record: unknown = JSON.parse(read.text);
      if (!record || typeof record !== 'object' || Array.isArray(record) || (record as {userId?: unknown}).userId !== id) return done(false, 'existing-owner-conflict');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return done(false, 'existing-pair-unavailable');
    }
    const initialized = initializeOperatorSecret();
    if (!initialized.ok) return done(false, 'operator-secret-unavailable', initialized.created);
    const proof = readOperatorSecret();
    if (proof.state !== 'ready' || !proof.secret) return done(false, 'operator-secret-unavailable', initialized.created);
    // Secret initialization is not authority to pair a subsequently changed bot/owner.
    if (telegramQuestionNamespace(loadConfigReadOnlyStrict()) !== binding) return done(false, 'configuration-changed', initialized.created);
    const ok = acceptTelegramPair(id, runs, proof.secret);
    return done(ok, ok ? 'paired' : 'pairing-record-refused', initialized.created);
  } catch { return done(false, 'configuration-or-storage-unavailable'); }
}

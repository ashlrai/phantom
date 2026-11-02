import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Provision the same private pairing record as a successful owner /pair. */
export function pairedTelegram(home: string, userId: number): void {
  const queue = join(home, '.ashlr-runs', 'queue');
  mkdirSync(queue, { recursive: true, mode: 0o700 });
  writeFileSync(join(queue, 'telegram-pair.json'), JSON.stringify({ v: 1, userId }), { mode: 0o600 });
}

/** Exact saved Phantom session metadata only; never starts the Verse server or an engine. */
import { isValidSessionId, readVerseNativeSessionBinding } from '../core/verse/session-store.js';

const USAGE = `usage: phm verse native-binding --id SESSION_ID [--json]

Read one bounded saved Phantom session metadata record. This does not inspect
live owners or desktop apps, list native conversations, launch an engine/provider,
resume a turn, or grant control. Existing read-only ACL assurance applies on Windows.
Exit 0: saved binding, 1: unavailable, 2: invalid arguments.
`;
export async function cmdVerseNativeBinding(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  let id: string | undefined; let json = false;
  const invalid = (): number => {
    const result = { error: 'Expected --id SESSION_ID and optional --json.' };
    if (args.includes('--json')) console.log(JSON.stringify(result)); else console.error(result.error);
    return 2;
  };
  if (args.length > 3) return invalid();
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--id' && id === undefined) {
      const value = args[++index];
      if (typeof value !== 'string' || !isValidSessionId(value)) return invalid();
      id = value;
    } else if (args[index] === '--json' && !json) json = true;
    else return invalid();
  }
  if (id === undefined) return invalid();
  let binding: ReturnType<typeof readVerseNativeSessionBinding> = null;
  try { binding = readVerseNativeSessionBinding(id); } catch { /* fixed unavailable error */ }
  if (!binding) {
    const result = { code: 'VERSE_NATIVE_BINDING_NOT_FOUND', error: 'Native session binding unavailable.' };
    if (json) console.log(JSON.stringify(result)); else console.error(result.error);
    return 1;
  }
  console.log(json ? JSON.stringify(binding, null, 2) : [
    `Saved native binding · ${binding.sessionId} · ${binding.engine}`,
    `Native ID: ${binding.nativeSessionId ?? binding.nativeIdState}`,
    `Saved status: ${binding.savedStatus} · Saved updated: ${binding.savedUpdatedAt}`,
    'Live owner: unverified · Desktop attachment: unverified · Control enabled: false.',
  ].join('\n'));
  return 0;
}

import type { Writable } from 'node:stream';
import { getDesktopUpdateTrust } from '../core/desktop/update-trust.js';
import { applyQualifiedDesktopUpdate, createDesktopUpdateDependencies, inspectQualifiedDesktopUpdate, prepareQualifiedDesktopUpdate, readQualifiedDesktopUpdateResult,
  type DesktopUpdateDependencies, type DesktopUpdateResult } from '../core/desktop/qualified-update.js';

const USAGE = `usage: phm desktop-update inspect|prepare|apply --stage <32 lowercase hex> --json

Inspect a publisher-signed app/CLI stage, verify both downloads before Stop
with prepare, or apply after verified native exit and prior Stop/drain.
No URL, path, shell, credential operation, Stop release or resident restart
is accepted. Authority approval remains separate.
`;
export function parseDesktopUpdateArgs(args: string[]): {verb: 'inspect'|'prepare'|'apply'; stage: string} | null {
  if (!args.length || args.length === 1 && ['help', '--help', '-h'].includes(args[0]!)) return null;
  const verb = args[0];
  if (args.length !== 4 || (verb !== 'inspect' && verb !== 'prepare' && verb !== 'apply') || args[1] !== '--stage' ||
      !/^[a-f0-9]{32}$/.test(args[2]!) || args[3] !== '--json') throw new Error('Invalid desktop-update arguments');
  return {verb, stage: args[2]!};
}
const closedOutput = (error: unknown) => ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'].includes((error as NodeJS.ErrnoException)?.code ?? '');
/** Only the native-update JSON channel owns this listener; no global IO errors are ignored. */
export function desktopUpdateJsonWriter(stream: Writable) {
  let failed: Error | null = null;
  const onError = (error: Error) => {failed = error;};
  stream.on('error', onError);
  return {
    write: async (value: DesktopUpdateResult): Promise<void> => {
      if (failed) throw failed;
      await new Promise<void>((resolve, reject) => stream.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve()));
    },
    dispose: async (): Promise<void> => {
      // Node may notify the stream error immediately after its write callback.
      await new Promise<void>(resolve => setImmediate(resolve));
      stream.removeListener('error', onError);
    },
  };
}
export async function cmdDesktopUpdate(args: string[], dependencies?: DesktopUpdateDependencies,
  emit?: (value: DesktopUpdateResult) => void | Promise<void>): Promise<number> {
  let options: ReturnType<typeof parseDesktopUpdateArgs>;
  try {options = parseDesktopUpdateArgs(args);} catch {console.error(USAGE); return 2;}
  if (!options) {console.log(USAGE); return 0;}
  const deps = dependencies ?? createDesktopUpdateDependencies(getDesktopUpdateTrust());
  const writer = emit ? null : desktopUpdateJsonWriter(process.stdout);
  const output = emit ?? writer!.write;
  try {
    let observed: DesktopUpdateResult;
    if (options.verb === 'inspect') {
      observed = inspectQualifiedDesktopUpdate(options.stage, deps);
      if (observed.reason === 'update-attempt-already-recorded') observed = await readQualifiedDesktopUpdateResult(options.stage, deps);
    } else if (options.verb === 'prepare') {
      observed = await prepareQualifiedDesktopUpdate(options.stage, deps);
    } else observed = await applyQualifiedDesktopUpdate(options.stage, deps, undefined, output);
    // Apply already fsynced its durable result. Normal native exit closes this
    // pipe; that expected output failure must not erase a completed transaction.
    try {await output(observed);} catch (error) {
      if (!closedOutput(error)) {console.error('Desktop update result channel failed.'); return 1;}
    }
    return observed.state === 'ready' || observed.state === 'applied' ? 0 : 1;
  } finally {await writer?.dispose();}
}

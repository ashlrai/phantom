import { declineCosDraft } from '../core/cos/decline.js';

const usage = 'Usage: ashlr fleet cos-decline <cos-id> --digest <64-hex> [--json]';

export async function cmdFleetCosDecline(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const outputError = (error: string): void => {
    if (json) console.log(JSON.stringify({ error }));
    else console.error(error);
  };
  let id: string | undefined;
  let digest: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') continue;
    if (arg === '--help' || arg === '-h') { console.log(json ? JSON.stringify({ usage }) : usage); return 0; }
    if (arg === '--digest' && digest === undefined) { digest = args[++i]; continue; }
    if (!id && !arg.startsWith('-')) { id = arg; continue; }
    outputError(usage);
    return 2;
  }
  if (!id || !/^cos-[a-f0-9]{32}$/.test(id) || !digest || !/^[a-f0-9]{64}$/.test(digest)) {
    outputError(usage);
    return 2;
  }
  try {
    const result = await declineCosDraft(id, digest);
    console.log(json ? JSON.stringify({ v: 1, ...result }) : `declined ${result.id}`);
    return 0;
  } catch {
    outputError('Unable to decline this draft; check the job, digest, and delivery status');
    return 1;
  }
}

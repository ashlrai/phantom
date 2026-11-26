/** `phm channels reply-state <request-id> [--json]`: the one state read every
 * channel adapter and agent uses before replying about a work item. Read-only. */
import { join } from 'node:path';
import { ashlrHome } from '../core/cloud/store.js';
import { readReplyState } from '../core/comms/reply-state.js';
import { scrubSecrets } from '../core/util/scrub.js';

const USAGE = 'usage: phm channels reply-state <request-id> [--json]';

export async function cmdChannelsReplyState(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(USAGE); return 0; }
  const json = args.includes('--json');
  const rest = args.filter(a => a !== '--json');
  const id = rest[0];
  if (rest.length !== 1 || !id || id.startsWith('-') || !id.trim()) { console.error(USAGE); return 2; }
  const state = readReplyState(id, { root: join(ashlrHome(), 'fleet'), now: Date.now() });
  let text = `${state.text}\nEvidence as of: ${state.asOf}`;
  if (!json && state.state === 'RUNNING' && state.evidence.running) {
    const clean = (value: string) => scrubSecrets(value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' '));
    text += `\nRunning evidence:\nSource: ${clean(state.evidence.running.source)}\nRecorded at: ${clean(state.evidence.running.at)}`;
  }
  if (!json && state.state === 'VERIFIED' && state.evidence.verified) {
    const proof = state.evidence.verified;
    const fields = [['PR', proof.pr], ['Head', proof.head], ['Tests', proof.tests], ['Artifact', proof.artifact]] as const;
    const lines = fields.filter(([, value]) => value != null && value !== '')
      .map(([label, value]) => `${label}: ${scrubSecrets(String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' '))}`);
    if (lines.length) text += `\nVerification details:\n${lines.join('\n')}`;
  }
  console.log(json ? JSON.stringify(state, null, 2) : text);
  return 0;
}

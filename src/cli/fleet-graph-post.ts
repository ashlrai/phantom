import { dirname, resolve } from 'node:path';
import { graphReadyPost, MAX_GRAPH_POST_BYTES } from '../core/fleet/graph-ready-post.js';
import type { BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const HELP = `ashlr fleet graph-post --file <json> [--apply] [--json]
Input: {batchId, completed: [taskId], tasks: [{id, dependsOn?: [taskId], envelope}]}.
Preview is the default. Maximum 256 KiB, 256 tasks, 32 ready messages.
Apply delivers bus work requests only; it does not execute jobs or mark completion.
Exit 0 preview/complete delivery, 1 transport refusal, 2 invalid input.`;

export async function cmdFleetGraphPost(args: string[], options: BusInboxOptions = {},
  deps: { emit?: (text: string) => void } = {}): Promise<number> {
  const emit = deps.emit ?? console.log;
  if (args.includes('--help') || args.includes('-h')) { emit(HELP); return 0; }
  let file: string | undefined, apply = false, json = false, valid = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--json' && !json) json = true;
    else if (arg === '--file' && file === undefined && args[i + 1] && !args[i + 1]!.startsWith('--')) file = args[++i];
    else valid = false;
  }
  let text: string | undefined;
  if (valid && file) {
    const path = resolve(file);
    const read = readStableRegularFile(path, { anchorPath: dirname(path),
      maxFileBytes: MAX_GRAPH_POST_BYTES, remainingBytes: MAX_GRAPH_POST_BYTES });
    if (read.ok) text = read.text;
  }
  const result = graphReadyPost(text ?? '', apply, options);
  const output = JSON.stringify(sanitizePublicJson(result));
  emit(json ? output : `Bus work-request delivery; job execution not started.\n${output}`);
  return result.status === 'invalid' ? 2 : result.status === 'preview' || result.status === 'complete' ? 0 : 1;
}

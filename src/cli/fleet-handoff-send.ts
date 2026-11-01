import { dirname, resolve } from 'node:path';
import { validateBusEnvelope } from '../core/fleet/bus-envelope.js';
import { appendBusInbox, type BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';
import { estimateHandoffTokens, renderHandoff, validateHandoff, type WorkerHandoff } from '../core/verse/handoff.js';

const usage = 'Usage: ashlr fleet handoff-send --file <json> --id <stable-message-id> --from <agent> --to <agent> [--apply] [--json]';
const maxBytes = 64 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(value).every(key => allowed.includes(key));

/** Check all shapes before calling the typed handoff helpers. */
function isHandoff(value: unknown): value is WorkerHandoff {
  if (!record(value) || !keys(value, ['id', 'task', 'files', 'constraints', 'check', 'findings']) ||
      typeof value.id !== 'string' || typeof value.task !== 'string' || typeof value.check !== 'string' ||
      !Array.isArray(value.files) || !Array.isArray(value.constraints)) return false;
  if (!value.files.every((file: unknown) => {
    if (!record(file) || !keys(file, ['path', 'lines', 'why']) || typeof file.path !== 'string' ||
        (file.why !== undefined && typeof file.why !== 'string')) return false;
    return file.lines === undefined || (record(file.lines) && keys(file.lines, ['from', 'to']) &&
      typeof file.lines.from === 'number' && typeof file.lines.to === 'number');
  })) return false;
  if (!value.constraints.every((item: unknown) => record(item) && keys(item, ['rule', 'reason']) &&
      typeof item.rule === 'string' && typeof item.reason === 'string')) return false;
  return value.findings === undefined || (Array.isArray(value.findings) &&
    value.findings.every((finding: unknown) => typeof finding === 'string'));
}

// JSON escaping plus explicit bidi/control escaping keeps terminal output inert.
function safeJson(value: unknown): string {
  return JSON.stringify(sanitizePublicJson(value)).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Validate a caller-supplied handoff and optionally append it to the local bus. */
export async function cmdFleetHandoffSend(args: string[], options: BusInboxOptions = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${usage}\nPreview by default. Routing labels do not authenticate agents or grant authority; no input is executed.`);
    return 0;
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if ((arg === '--apply' || arg === '--json') && !flags.has(arg)) flags.add(arg);
    else if (['--file', '--id', '--from', '--to'].includes(arg) && !values.has(arg) &&
      args[i + 1] && !args[i + 1]!.startsWith('-') && !args[i + 1]!.includes('\0')) values.set(arg, args[++i]!);
    else { console.error(`Invalid arguments. ${usage}`); return 2; }
  }
  const file = values.get('--file'), id = values.get('--id'), from = values.get('--from'), to = values.get('--to');
  if (!file || !id || !from || !to) { console.error(`Invalid arguments. ${usage}`); return 2; }
  const json = flags.has('--json');
  const fail = (problems: unknown): number => {
    if (json) console.log(safeJson({ v: 1, valid: false, problems }));
    else console.error(`handoff-send: ${safeJson(problems)}`);
    return 1;
  };
  const absolute = resolve(file);
  const read = readStableRegularFile(absolute, { anchorPath: dirname(absolute), maxFileBytes: maxBytes, remainingBytes: maxBytes });
  if (!read.ok) return fail([{ field: 'file', detail: `unreadable (${read.reason})` }]);
  let input: unknown;
  try { input = JSON.parse(read.text) as unknown; }
  catch { return fail([{ field: 'handoff', detail: 'must be valid JSON' }]); }
  if (!isHandoff(input)) return fail([{ field: 'handoff', detail: 'invalid JSON shape' }]);
  const problems = validateHandoff(input);
  if (problems.length) return fail(problems.slice(0, 50));
  const prompt = renderHandoff(input);
  const checked = validateBusEnvelope({ id, from, to, priority: 'P3', ttl: 86_400_000,
    body: { kind: 'worker-handoff', taskId: input.id, prompt } });
  if (!checked.ok) return fail(checked.issues);
  if (!flags.has('--apply')) {
    const preview = { v: 1, valid: true, status: 'preview', destination: to,
      renderedChars: prompt.length, estimatedTokens: estimateHandoffTokens(input), envelope: checked.value };
    if (json) console.log(safeJson(preview));
    else console.log(`Validated handoff preview: ${prompt.length} characters, ${preview.estimatedTokens} estimated tokens; destination ${safeJson(to)}.`);
    return 0;
  }
  const receipt = appendBusInbox(checked.value, options);
  if (json) console.log(safeJson({ v: 1, ...receipt }));
  else console.log(`handoff-send: ${safeJson(receipt)}`);
  return receipt.status === 'posted' || receipt.status === 'duplicate' ? 0 : 1;
}

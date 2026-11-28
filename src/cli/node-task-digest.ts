/** `phm node task-digest`: print the `phm node enqueue --task-sha256` value for embedded task text. Thin: task.ts owns the task rules. */
import { NODE_TASK_LIMIT, NODE_TASK_PART_LIMIT, nodeTaskDigest } from '../core/drive/nodes/task.js';

export const NODE_TASK_DIGEST_USAGE = `Usage: phm node task-digest --task-part <text> [--task-part <text>...] [--json]

Prints the --task-sha256 value for embedded task text, so 'phm node enqueue
--pack codex-file' never needs a platform sha256 tool:
  phm node enqueue --job <id> --owner <scope> --pack codex-file \\
    --task-part "$TASK" --task-sha256 "$(phm node task-digest --task-part "$TASK")" --json

Repeat --task-part for long text — the parts join in order under the same
rules enqueue applies (each at most 4000 characters, 16 KiB joined), so the
printed digest is always one enqueue accepts. The digest covers the exact
joined text: pass the same parts to both commands. Default output is the
bare sha256:<hex> value, so command substitution pastes it directly; --json
wraps it in the standard {schemaVersion,command} envelope. The text is hashed
locally and never leaves this machine.`;

export async function cmdNodeTaskDigest(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const fail = (message: string, fix: string, code: string): number => {
    if (json) console.log(JSON.stringify({ schemaVersion: 1, command: 'task-digest', error: { code, message, fix } }));
    else console.error(`${message} Fix: ${fix}`);
    return 2;
  };
  // The same --task-part contract parseNodeFleetFlags applies for enqueue:
  // repeatable, joined in order, each part at most 4000 characters and 16 KiB
  // joined. A separate-arg value starting with -- is refused as ambiguous;
  // the --task-part= form carries it literally.
  let text: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    let value: string | undefined;
    let inline = false;
    if (arg === '--task-part') value = args[++i];
    else if (arg.startsWith('--task-part=')) { value = arg.slice('--task-part='.length); inline = true; }
    else return fail(`Unknown argument ${arg}.\n${NODE_TASK_DIGEST_USAGE}`, 'Run: phm node task-digest --help', 'usage');
    if (value === undefined || (!inline && value.startsWith('--'))) {
      return fail('--task-part needs a value.\n' + NODE_TASK_DIGEST_USAGE, 'Run: phm node task-digest --help', 'usage');
    }
    const joined = (text ?? '') + value;
    if (value.length > NODE_TASK_PART_LIMIT || Buffer.byteLength(joined) > NODE_TASK_LIMIT) {
      return fail('Invalid embedded node task: --task-part is limited to 4000 characters per part and 16 KiB in total.',
        'Split the task into smaller --task-part values or shorten it. Run: phm node task-digest --help', 'bad-task');
    }
    text = joined;
  }
  if (text === undefined) {
    return fail(`--task-part is required.\n${NODE_TASK_DIGEST_USAGE}`, 'Add --task-part <text>. Run: phm node task-digest --help', 'missing-flag');
  }
  const digest = nodeTaskDigest(text);
  if (digest === null) {
    return fail('Invalid embedded node task: the text must be non-empty UTF-8 of at most 16 KiB and carry no secret-shaped strings.',
      'Pass plain task text within those limits. Run: phm node task-digest --help', 'bad-task');
  }
  console.log(json ? JSON.stringify({ schemaVersion: 1, command: 'task-digest', taskSha256: digest }) : digest);
  return 0;
}

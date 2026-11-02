import { dirname, resolve } from 'node:path';
import {
  estimateHandoffTokens,
  renderHandoff,
  validateHandoff,
  type HandoffProblem,
  type WorkerHandoff,
} from '../core/verse/handoff.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_PROBLEMS_EMITTED = 50;
const HELP = `Usage: phm knowledge handoff --file <handoff.json> [--json]

Validate a planner-to-worker handoff and render the bounded worker prompt.
Input is an owner-controlled regular JSON file of at most 64 KiB:
  {"id":"w1","task":"applyDiscount treats pct as flat; make it a percentage",
   "files":[{"path":"src/cart.js","lines":{"from":6,"to":8},"why":"the function"}],
   "constraints":[{"rule":"Keep the signature","reason":"two external callers"}],
   "check":"applyDiscount(100, 10) returns 90","findings":["optional note"]}
Every field is required except findings; constraints may be an empty array.
File references stay paths, never pasted contents; every constraint keeps its
reason; the rendered prompt must stay within 6000 characters. No path is
fetched, no check string is executed, and findings are data, not instructions.

Text mode prints the rendered prompt. --json emits a single versioned object:
{v:1, valid:true, prompt, estimatedTokens, renderedChars} on success, or
{v:1, valid:false, problems:[{field,detail}]} with bounded field problems.
Exit 0 valid, 1 unreadable input or failed validation, 2 bad arguments.
`;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unexpectedKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).some(key => !allowed.includes(key));
}

/**
 * Check the parsed JSON is structurally a WorkerHandoff before the typed
 * helpers see it: every present field has the right type, no field is missing,
 * and no unknown key survives. Semantics (blank strings, pasted contents, the
 * rendered ceiling) stay with validateHandoff; nothing here coerces a value.
 * Problems name locations only — input data is never echoed.
 */
function shapeProblems(value: unknown): HandoffProblem[] {
  const problems: HandoffProblem[] = [];
  if (!isObject(value)) {
    problems.push({ field: 'handoff', detail: 'must be a JSON object' });
    return problems;
  }
  if (unexpectedKeys(value, ['id', 'task', 'files', 'constraints', 'check', 'findings'])) {
    problems.push({ field: 'handoff', detail: 'unexpected key' });
  }
  for (const field of ['id', 'task', 'check'] as const) {
    if (typeof value[field] !== 'string') problems.push({ field, detail: 'must be a string' });
  }
  if (!Array.isArray(value.files)) {
    problems.push({ field: 'files', detail: 'must be an array' });
  } else {
    value.files.forEach((ref, index) => {
      const base = `files[${index}]`;
      if (!isObject(ref)) {
        problems.push({ field: base, detail: 'must be an object' });
        return;
      }
      if (unexpectedKeys(ref, ['path', 'lines', 'why'])) {
        problems.push({ field: base, detail: 'unexpected key' });
      }
      if (typeof ref.path !== 'string') problems.push({ field: `${base}.path`, detail: 'must be a string' });
      if (ref.why !== undefined && typeof ref.why !== 'string') {
        problems.push({ field: `${base}.why`, detail: 'must be a string' });
      }
      if (ref.lines !== undefined) {
        if (!isObject(ref.lines)) {
          problems.push({ field: `${base}.lines`, detail: 'must be an object' });
        } else {
          if (unexpectedKeys(ref.lines, ['from', 'to'])) {
            problems.push({ field: `${base}.lines`, detail: 'unexpected key' });
          }
          for (const bound of ['from', 'to'] as const) {
            if (typeof ref.lines[bound] !== 'number') {
              problems.push({ field: `${base}.lines.${bound}`, detail: 'must be a number' });
            }
          }
        }
      }
    });
  }
  if (!Array.isArray(value.constraints)) {
    problems.push({ field: 'constraints', detail: 'must be an array' });
  } else {
    value.constraints.forEach((constraint, index) => {
      const base = `constraints[${index}]`;
      if (!isObject(constraint)) {
        problems.push({ field: base, detail: 'must be an object' });
        return;
      }
      if (unexpectedKeys(constraint, ['rule', 'reason'])) {
        problems.push({ field: base, detail: 'unexpected key' });
      }
      for (const field of ['rule', 'reason'] as const) {
        if (typeof constraint[field] !== 'string') {
          problems.push({ field: `${base}.${field}`, detail: 'must be a string' });
        }
      }
    });
  }
  if (value.findings !== undefined &&
      (!Array.isArray(value.findings) || !value.findings.every(f => typeof f === 'string'))) {
    problems.push({ field: 'findings', detail: 'must be an array of strings' });
  }
  return problems;
}

export async function runKnowledgeHandoff(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const invalid = (message: string): number => {
    process.stderr.write(`error: ${message}\n`);
    return 2;
  };
  let file: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--file' && file === undefined) {
      const value = args[++i];
      if (!value?.trim() || value.startsWith('-') || value.includes('\0')) {
        return invalid('--file requires a path');
      }
      file = value;
    } else return invalid(`Unexpected argument or flag: ${arg}`);
  }
  if (file === undefined) return invalid('--file is required');

  const fail = (problems: readonly HandoffProblem[]): number => {
    const omitted = Math.max(0, problems.length - MAX_PROBLEMS_EMITTED);
    if (json) {
      process.stdout.write(JSON.stringify({
        v: 1,
        valid: false,
        problems: problems.slice(0, MAX_PROBLEMS_EMITTED),
        ...(omitted > 0 ? { omittedProblemCount: omitted } : {}),
      }) + '\n');
    } else {
      process.stderr.write(`error: invalid handoff (${problems.length} problem${problems.length === 1 ? '' : 's'})\n`);
      for (const problem of problems.slice(0, MAX_PROBLEMS_EMITTED)) {
        process.stderr.write(`  ${problem.field}: ${problem.detail}\n`);
      }
      if (omitted > 0) process.stderr.write(`  … and ${omitted} more\n`);
    }
    return 1;
  };

  const absolute = resolve(file);
  const read = readStableRegularFile(absolute, {
    anchorPath: dirname(absolute), maxFileBytes: MAX_INPUT_BYTES, remainingBytes: MAX_INPUT_BYTES,
  });
  if (!read.ok) return fail([{ field: 'file', detail: `unreadable (${read.reason})` }]);

  let input: unknown;
  try { input = JSON.parse(read.text) as unknown; }
  catch { return fail([{ field: 'handoff', detail: 'must be valid JSON' }]); }

  const shape = shapeProblems(input);
  if (shape.length > 0) return fail(shape);

  const problems = validateHandoff(input as WorkerHandoff);
  if (problems.length > 0) return fail(problems);

  const rendered = renderHandoff(input as WorkerHandoff);
  if (json) {
    process.stdout.write(JSON.stringify({
      v: 1,
      valid: true,
      prompt: rendered,
      estimatedTokens: estimateHandoffTokens(input as WorkerHandoff),
      renderedChars: rendered.length,
    }) + '\n');
  } else {
    process.stdout.write(rendered + '\n');
  }
  return 0;
}

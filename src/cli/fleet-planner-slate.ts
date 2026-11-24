/**
 * `ashlr fleet planner-slate` - declare the planner fallback list from a file, or with --propose print a read-only proposal built from the pools that have usage left.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { proposePlannerSlate, type PlannerSlateProposal } from '../core/fleet/planner-slate-propose.js';
import { MAX_SLATE_BYTES, parsePlannerSlate, readSlateFile, writePlannerSlate } from '../core/fleet/planner-slate-write.js';

type IO = { stdin?: AsyncIterable<Uint8Array | string>; stdout?: { write(text: string): unknown } };

export const usage = 'Usage: ashlr fleet planner-slate --file <abs|-> [--runs-dir <abs>] [--json] | --propose [--runs-dir <abs>] [--json]';

function proposalWords(p: PlannerSlateProposal): string {
  const out = [p.current === 'ok' ? 'A planner fallback list is already declared; this is what would replace it.'
    : p.current === 'invalid' ? 'The declared planner fallback list cannot be read; this is a replacement.'
      : 'No planner fallback list is declared; this is a proposal.'];
  p.lanes.forEach((l, i) => out.push(`${i + 1}. ${l.provider}: ${l.why}${l.resetAt ? `, resets ${l.resetAt}` : ''}`));
  for (const s of p.skipped) out.push(`Left out ${s.pool}: ${s.why}.`);
  out.push(...p.notes);
  if (p.slate) out.push('', JSON.stringify(p.slate, null, 2));
  return out.join('\n');
}

/** Read-only: prints the proposal, never writes the slate file. */
async function propose(args: string[], output: { write(text: string): unknown }): Promise<number> {
  let json = false, root: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--propose') continue;
    if (flag === '--json' && !json) json = true;
    else if (flag === '--runs-dir' && root === undefined && args[i + 1] && isAbsolute(args[i + 1]!) && !args[i + 1]!.includes('\0')) root = args[++i];
    else { output.write(`${usage}\n`); return 2; }
  }
  const proposal = await proposePlannerSlate(root === undefined ? {} : { runsDir: root });
  output.write(`${json ? JSON.stringify(proposal) : proposalWords(proposal)}\n`);
  return 0;
}

export async function cmdFleetPlannerSlate(args: string[], io: IO = {}): Promise<number> {
  const output = io.stdout ?? process.stdout;
  if (args.includes('--propose')) return args.includes('--file') ? (output.write(`${usage}\n`), 2) : propose(args, output);
  const report = (status: 'written' | 'unchanged' | 'refused', count: number, code: number): number => {
    output.write(`${JSON.stringify({ v: 1, status, candidateCount: count })}\n`);
    return code;
  };
  let file: string | undefined, root: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json' && !json) { json = true; continue; }
    if ((flag === '--file' && file === undefined) || (flag === '--runs-dir' && root === undefined)) {
      const value = args[++i];
      if (!value || value.startsWith('--') || value.includes('\0')) return report('refused', 0, 2);
      if (flag === '--file') file = value; else root = value;
      continue;
    }
    return report('refused', 0, 2);
  }
  if (!file || (root !== undefined && !isAbsolute(root))) return report('refused', 0, 2);
  let input: Buffer;
  try {
    if (file === '-') {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of io.stdin ?? process.stdin) {
        const bytes = Buffer.from(chunk); length += bytes.length;
        if (length > MAX_SLATE_BYTES) return report('refused', 0, 2);
        chunks.push(bytes);
      }
      input = Buffer.concat(chunks, length);
    } else input = readSlateFile(file);
  } catch { return report('refused', 0, 2); }
  const slate = parsePlannerSlate(input);
  if (!slate) return report('refused', 0, 2);
  const status = writePlannerSlate(root ?? join(homedir(), '.ashlr-runs'), slate);
  return report(status, slate.candidates.length, status === 'refused' ? 1 : 0);
}

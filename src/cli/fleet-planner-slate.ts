import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { MAX_SLATE_BYTES, parsePlannerSlate, readSlateFile, writePlannerSlate } from '../core/fleet/planner-slate-write.js';

type IO = { stdin?: AsyncIterable<Uint8Array | string>; stdout?: { write(text: string): unknown } };

export async function cmdFleetPlannerSlate(args: string[], io: IO = {}): Promise<number> {
  const output = io.stdout ?? process.stdout;
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

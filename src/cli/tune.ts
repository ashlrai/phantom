import { execFile } from 'node:child_process';
import { readFile, open, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { evaluateAdapter, type TuneObservation } from '../core/tune/evaluation.js';
import { prepareDataset } from '../core/tune/dataset.js';

const USAGE = 'Usage: phm tune prepare <reviewed-samples.jsonl> <new-output-directory> <scrub.pl> | evaluate <paired-report.json>';
async function boundedRead(path: string): Promise<string> {
  const handle = await open(resolve(path), 'r');
  try {
    if ((await handle.stat()).size > 8 * 1024 * 1024) throw new Error('bound');
    const raw = await handle.readFile('utf8');
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('bound');
    return raw;
  } finally { await handle.close(); }
}
export async function cmdTune(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  if (!((args.length === 4 && args[0] === 'prepare') || (args.length === 2 && args[0] === 'evaluate'))) {
    console.error(USAGE); return 2;
  }
  try {
    const raw = await boundedRead(args[1]!);
    if (args[0] === 'evaluate') {
      const input = JSON.parse(raw) as { baseline: TuneObservation[]; candidate: TuneObservation[]; heldoutIds: string[] };
      const report = evaluateAdapter(input.baseline, input.candidate, input.heldoutIds);
      console.log(JSON.stringify(report)); return report.decision === 'reject' ? 1 : 0;
    }
    const scanner = resolve(args[3]!);
    // Check tool availability separately: a missing scanner must fail the whole run.
    await readFile(scanner);
    const data = await prepareDataset(raw.split('\n').filter(s => s.trim()).map(s => JSON.parse(s) as unknown), input =>
      new Promise<boolean>(resolveCheck => {
        const child = execFile('perl', [scanner, '--check'], { timeout: 10_000, maxBuffer: 1024 }, error => resolveCheck(!error));
        child.stdin?.on('error', () => resolveCheck(false));
        child.stdin?.end(input);
      }));
    const out = resolve(args[2]!);
    await mkdir(out, { mode: 0o700 }); // Exclusive: never mix datasets or overwrite an earlier run.
    for (const name of ['train', 'valid', 'test', 'preferences'] as const) {
      const file = await open(join(out, `${name}.jsonl`), 'wx', 0o600);
      try { await file.writeFile(data[name].map(s => JSON.stringify(s)).join('\n') + '\n'); }
      finally { await file.close(); }
    }
    const manifest = await open(join(out, 'manifest.json'), 'wx', 0o600);
    try { await manifest.writeFile(JSON.stringify(data.manifest, null, 2) + '\n'); }
    finally { await manifest.close(); }
    console.log(JSON.stringify(data.manifest)); return 0;
  } catch { console.error('Tune refused: invalid input, scanner, bounds, or output. No lane changed.'); return 1; }
}

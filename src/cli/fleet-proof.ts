import { capturePublishProof } from '../core/fleet/proof-capture.js';
import { verifyProofResult } from '../core/fleet/proof-envelope.js';

const usage = 'Usage: phm fleet proof verify <resultRef> [--json]\nPublisher capture: phm fleet proof capture --repo <path> --git-dir <trusted-path> [--layout linked|repo] --base <sha40> --output <file> [--test-log <file> --test-command <cmd> --test-exit <0..255>]';
export async function cmdFleetProof(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args[0] === 'verify' && args[1] && !args[1].startsWith('-') &&
      (args.length === 2 || (args.length === 3 && args[2] === '--json'))) {
    const review = verifyProofResult(args[1]);
    console.log(args[2] === '--json' ? JSON.stringify(review) : [
      `Proof: ${review.ok ? 'PASS' : 'NEEDS REVIEW'}`,
      ...review.checklist.map(item => `[ ] ${item}`), ...review.flags.map(flag => `FLAG: ${flag}`),
    ].join('\n'));
    return review.ok ? 0 : 1;
  }
  if (args[0] === 'capture') {
    const options = new Map<string, string>();
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i]!, value = args[i + 1];
      if (!['--repo', '--git-dir', '--layout', '--base', '--output', '--test-log', '--test-command', '--test-exit'].includes(key) || options.has(key) || !value || value.startsWith('--')) { console.error(usage); return 2; }
      options.set(key, value);
    }
    const gitDir = options.get('--git-dir'), layout = options.get('--layout');
    const repo = options.get('--repo'), base = options.get('--base'), output = options.get('--output');
    const log = options.get('--test-log'), cmd = options.get('--test-command'), code = options.get('--test-exit');
    if (!repo || !gitDir || !base || !output || (layout !== undefined && layout !== 'repo' && layout !== 'linked') || ([log, cmd, code].some(v => v !== undefined) && !(log && cmd && code && /^\d{1,3}$/.test(code)))) { console.error(usage); return 2; }
    try {
      const proof = capturePublishProof({ repo, gitDir, layout: layout as 'repo' | 'linked' | undefined, base, output, ...(log && cmd && code ? { test: { log, cmd, exitCode: Number(code) } } : {}) });
      console.log(`PROOF ${proof.file} sha256:${proof.sha256}`);
      return 0;
    } catch { console.error('Proof capture failed: invalid input, unavailable artifacts or existing bundle.'); return 1; }
  }
  console.error(usage); return 2;
}

import { parseTask } from './contract.js';
import { postGrokbotTask } from './transport.js';

// Invoked only as a child of phantom exec. No credential or error is printed.
async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 16_384) throw new Error('oversized input');
  }
  await postGrokbotTask(parseTask(JSON.parse(input), Date.now()), process.env.GROKBOT_BASE_URL);
}
void main().catch(() => { process.exitCode = 1; });

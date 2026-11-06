/** Offline scoring of independently collected Responses API / Codex results. */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { pathToFileURL } from 'node:url';

// The evaluator never sends these answers to the model. Capture the HTML fixture
// as an image for the two visual cases; keep the entire image and prompts fixed.
export const cases = [
  { id: 'coding-boundary', lane: 'coding', prompt: 'A function clamp(x, min, max) should constrain x inclusively. For x=11, min=0, max=10, what integer must it return? Reply with only the integer.', answer: '10' },
  { id: 'coding-regression', lane: 'coding', prompt: 'An empty list must return 0; [2,3] must return 5. Which expression meets both: A) xs.reduce((a,b)=>a+b) or B) xs.reduce((a,b)=>a+b, 0)? Reply A or B.', answer: 'B' },
  { id: 'visual-verifier', lane: 'visual', prompt: 'Compare expected and observed failure panels in the image. Are they equivalent? Reply PASS or FAIL.', answer: 'FAIL' },
  { id: 'computer-verifier', lane: 'computer', prompt: 'A computer-use agent claims the settings were saved and notifications are off. Does the observed failure panel verify the claim? Reply PASS or FAIL.', answer: 'FAIL' },
  { id: 'visual-pass', lane: 'visual', prompt: 'Do the notification and save status values in the expected and observed success panels match? Reply PASS or FAIL.', answer: 'PASS' },
  { id: 'computer-pass', lane: 'computer', prompt: 'An agent claims the settings were saved and notifications are off. Does the observed success panel verify the claim? Reply PASS or FAIL.', answer: 'PASS' },
  { id: 'triage', lane: 'triage', prompt: 'A deployment changed payment code and payment tests fail. Classify urgency: P1 or P3. Reply only P1 or P3.', answer: 'P1' },
];
const arms = [
  { id: 'sol', model: 'gpt-6.1-sol', effort: 'medium' },
  { id: 'terra', model: 'gpt-6.1-terra', effort: 'medium' },
  { id: 'terra-none', model: 'gpt-6.1-terra', effort: 'none' },
];

/** Require complete paired trials; no missing or failed request becomes a pass. */
export function score(receipt) {
  if (!receipt || !Number.isSafeInteger(receipt.trials) || receipt.trials < 1 || receipt.trials > 100 || !Array.isArray(receipt.results)) throw Error('Invalid receipt');
  const expected = arms.flatMap(arm => cases.filter(c => arm.id !== 'terra-none' || c.lane === 'triage').flatMap(c =>
    Array.from({ length: receipt.trials }, (_, i) => `${arm.id}/${c.id}/${i + 1}`)));
  const records = new Map();
  for (const r of receipt.results) {
    const arm = arms.find(a => a.id === r?.arm);
    const key = `${r?.arm}/${r?.caseId}/${r?.trial}`;
    if (!arm || r.model !== arm.model || r.effort !== arm.effort || !expected.includes(key) || records.has(key) ||
      typeof r.answer !== 'string' || !Number.isFinite(r.elapsedMs) || r.elapsedMs < 0 ||
      !Number.isSafeInteger(r.inputTokens) || r.inputTokens < 0 || !Number.isSafeInteger(r.outputTokens) || r.outputTokens < 0) throw Error('Invalid result');
    records.set(key, r);
  }
  if (records.size !== expected.length) throw Error('Incomplete paired receipt');
  return arms.map(arm => ({ arm: arm.id, model: arm.model, effort: arm.effort, lanes: Object.fromEntries(
    [...new Set(cases.filter(c => arm.id !== 'terra-none' || c.lane === 'triage').map(c => c.lane))].map(lane => {
      const rows = [...records.values()].filter(r => r.arm === arm.id && cases.some(c => c.id === r.caseId && c.lane === lane));
      return [lane, { passed: rows.filter(r => r.answer.trim() === cases.find(c => c.id === r.caseId).answer).length,
        total: rows.length, elapsedMs: rows.reduce((n, r) => n + r.elapsedMs, 0),
        inputTokens: rows.reduce((n, r) => n + r.inputTokens, 0), outputTokens: rows.reduce((n, r) => n + r.outputTokens, 0) }];
    })) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(score(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2)); }
  catch { console.error('Invalid or incomplete receipt'); process.exitCode = 1; }
}

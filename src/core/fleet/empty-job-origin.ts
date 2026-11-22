/** Fixed labels only: never echo evidence from a publish file or worker log. */
import { FLEET_EMPTY_WHY_LOG_LINES } from './empty-why-classify.js';

export type EmptyJobCause = 'no-eligible-pr' | 'already-on-master' | 'auth' | 'infra' | 'gate' | 'no-change' | 'unknown';
const RULES: readonly (readonly [EmptyJobCause, RegExp])[] = [
  ['auth', /\b(?:not (?:signed|logged) in|(?:sign|log)[ -]?in (?:required|failed)|authentication (?:failed|required)|unauthorized|missing (?:api )?key|(?:api )?key (?:missing|not set))\b/i],
  ['gate', /\bsecret[ -]shape\b|\bG1\b[^\n]{0,30}\b(?:fail|block|reject|denied)|\b(?:fail|block|reject|ABORT)\w*[^\n]{0,30}\bG1\b/i],
  ['infra', /\bshallow\.lock\b|\b(?:fetch[^\n]{0,40}(?:race|fail|abort)|(?:ABORT[ -])?default-fetch|abort(?:ed)? after push|RESULT ABORT)\b/i],
  ['already-on-master', /\balready (?:on|in|landed on|merged (?:in|to|into)) (?:origin\/)?(?:master|main)\b|\balready (?:shipped|implemented|landed)\b/i],
  ['no-eligible-pr', /\bNO[ _-]CANDIDATE\b|\bno (?:eligible|open|matching|conflicting) (?:prs?|pull requests?|targets?|candidates?)\b|\bnothing (?:left )?to (?:recut|land)\b/i],
  ['no-change', /\bbuilt nothing\b|\bno[ _-]change\b|\bno[ _-]diff\b|\bno (?:code )?changes? (?:made|produced|needed|required)\b|\bnothing to commit\b|\bworking tree clean\b/i],
];
export function emptyJobCause(log: string | null, publish: string | null): EmptyJobCause {
  const text = [publish, log].map(s => s?.split(/\r?\n/).slice(-FLEET_EMPTY_WHY_LOG_LINES).join('\n') ?? '').join('\n');
  return RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? 'unknown';
}

/** Inferred id families, not proof of the actual producer (use jobs producers for recorded src). */
const GENERATORS: readonly (readonly [string, RegExp])[] = [
  ['GAP*', /^RQ-PHX-GAP/], ['LAND*DIRTY', /^RQ-PHX-LAND.*DIRTY/], ['LAND*', /^RQ-PHX-LAND/],
  ['RED*FIX*', /^RQ-PHX-RED.*FIX/], ['CL-DOCS-*', /^RQ-CL-DOCS-/], ['FIXUP-*', /^(?:RQ-)?FIXUP-/],
  ['autofill', /^RQ-(?:(?:PHX-)?IDEA|FOLLOWUP-|AUTOFILL)/], ['leader *Q8', /^RQ-.*Q8$/],
];
export const emptyJobGenerator = (id: string): string => GENERATORS.find(([, pattern]) => pattern.test(id))?.[0] ?? 'unknown';

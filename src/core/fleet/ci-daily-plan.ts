/**
 * CI daily plan (Mason, Nov 1 2026): GitHub Actions run at most once a day per
 * repo — a staggered nightly schedule — with per-PR and per-push triggers
 * removed. Merges gate on the fast local check instead of a per-PR workflow.
 *
 * Workflow files are owner-reviewed, so the fleet never writes them: this
 * module only computes the change. `planWorkflow` rewrites one file's `on:`
 * block in memory (parseDocument keeps comments and key order); `planCiDaily`
 * plans every file, assigns deterministic staggered crons, and renders a
 * unified diff `git apply` accepts. See docs/CI-DAILY-PLAN.md.
 */
import { Pair, Scalar, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml';
import type { YAMLMap, YAMLSeq } from 'yaml';

export type WorkflowTriggerPlan = {
  file: string;
  name: string | null;
  action: 'keep' | 'change' | 'skip';
  removed: string[];
  kept: string[];
  added: string[];
  cron: string | null;
  reason: string;
  before: string;
  after: string;
};

export type CiDailyPlan = {
  plans: WorkflowTriggerPlan[];
  patch: string;
  summary: string;
  followUps: string[];
};

/** Triggers the Nov 1 order removes outright. push is handled separately. */
const PR_TRIGGERS = new Set(['pull_request', 'pull_request_target']);
/** Keys a tags-only `push:` map may carry and still be kept. */
const PUSH_TAGS_KEYS = new Set(['tags', 'paths', 'paths-ignore']);

/** Nightly window the default crons spread across: 09:03–09:30 UTC. */
const DAILY_HOUR_UTC = 9;
const DAILY_MIN_FIRST = 3;
const DAILY_MIN_LAST = 30;
const FALLBACK_CRON = `${DAILY_MIN_FIRST} ${DAILY_HOUR_UTC} * * *`;

/** git-style unified diff context radius. */
const CONTEXT = 3;
/** Above this mid-size product, emit one coarse hunk instead of LCS (correct, not minimal). */
const LCS_LIMIT = 4_000_000;

type Trigger = { name: string; value: unknown };

function scalarString(node: unknown): string | null {
  return isScalar(node) && node.value != null ? String(node.value) : null;
}

/** Read the top-level `on:` triggers in document order from a parsed map. */
function inspectOn(onNode: unknown): { triggers: Trigger[]; scheduleCrons: string[] } {
  const triggers: Trigger[] = [];
  if (isMap(onNode)) {
    for (const pair of onNode.items) {
      const name = scalarString(pair.key);
      if (name !== null) triggers.push({ name, value: pair.value ?? null });
    }
  } else if (isSeq(onNode)) {
    for (const item of onNode.items) {
      const name = scalarString(item);
      if (name !== null) triggers.push({ name, value: null });
    }
  } else {
    const name = scalarString(onNode);
    if (name !== null) triggers.push({ name, value: null });
  }
  const scheduleCrons: string[] = [];
  const schedule = triggers.find((t) => t.name === 'schedule')?.value;
  if (isSeq(schedule)) {
    for (const item of schedule.items) {
      const cron = isMap(item) ? scalarString(item.get('cron', true)) : null;
      if (cron !== null) scheduleCrons.push(cron);
    }
  }
  return { triggers, scheduleCrons };
}

/**
 * `push` survives only when filtered to tags: a bare push (or one keyed by
 * branches / tags-ignore) still fires on branch pushes, which the order removes.
 */
function pushIsTagsOnly(value: unknown): boolean {
  if (!isMap(value)) return false;
  const keys = value.items.map((p) => scalarString(p.key)).filter((k): k is string => k !== null);
  return keys.includes('tags') && keys.every((k) => PUSH_TAGS_KEYS.has(k));
}

function classify(name: string, value: unknown, keepMergeGroup: boolean): 'remove' | 'keep' | 'keep-tags' {
  if (PR_TRIGGERS.has(name)) return 'remove';
  if (name === 'push') return pushIsTagsOnly(value) ? 'keep-tags' : 'remove';
  if (name === 'merge_group' && !keepMergeGroup) return 'remove';
  return 'keep';
}

const lineStart = (text: string, offset: number): number => text.lastIndexOf('\n', offset - 1) + 1;
/**
 * Offset just past the newline terminating the pair's last content line.
 * Node range[1] may sit at the next line's start (it can include the trailing
 * newline), so scan from `contentEnd - 1`, not from `contentEnd`.
 */
const pairLineEnd = (text: string, contentEnd: number): number => {
  const nl = text.indexOf('\n', Math.max(0, contentEnd - 1));
  return nl === -1 ? text.length : nl + 1;
};
/** Offset just past the newline ending the line containing `offset` (or EOF). */
const afterLine = (text: string, offset: number): number => {
  const nl = text.indexOf('\n', offset);
  return nl === -1 ? text.length : nl + 1;
};
const leadingWs = (text: string, offset: number): string => /^[ \t]*/.exec(text.slice(lineStart(text, offset)))![0];

/**
 * Splice rewrite for a block `on:` map: delete each removed trigger's full
 * line span, insert `schedule:` at the end of the surviving map. Byte-minimal:
 * everything else — comments, flow spacing, line wrapping — stays untouched.
 */
function spliceOnMap(text: string, onMap: YAMLMap, onKeyOffset: number, removed: string[], cron: string | null): string | null {
  const cuts: { start: number; end: number }[] = [];
  const surviving: { key: string; end: number; indent: string }[] = [];
  for (const pair of onMap.items) {
    const name = scalarString(pair.key);
    const keyRange = isNode(pair.key) ? pair.key.range : null;
    const valueRange = isNode(pair.value) ? pair.value.range : null;
    const pairEnd = pair.value != null ? valueRange?.[1] ?? null : keyRange?.[1] ?? null;
    if (name === null || keyRange == null || pairEnd === null) return null;
    if (removed.includes(name)) {
      cuts.push({ start: lineStart(text, keyRange[0]), end: pairLineEnd(text, pairEnd) });
    } else {
      surviving.push({ key: name, end: pairEnd, indent: leadingWs(text, keyRange[0]) });
    }
  }
  let insert: { at: number; text: string } | null = null;
  if (cron !== null) {
    const last = surviving[surviving.length - 1];
    const indent = last ? last.indent : leadingWs(text, onKeyOffset) + '  ';
    const at = last ? pairLineEnd(text, last.end) : afterLine(text, onKeyOffset);
    // `at` is a line boundary unless the file ends without a newline.
    const quoted = cron.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    insert = { at, text: `${at > 0 && text[at - 1] !== '\n' ? '\n' : ''}${indent}schedule:\n${indent}  - cron: "${quoted}"\n` };
  }
  let out = text;
  for (const cut of [...cuts].sort((a, b) => b.start - a.start)) out = out.slice(0, cut.start) + out.slice(cut.end);
  if (insert) {
    const shift = cuts.filter((c) => c.end <= insert!.at).reduce((n, c) => n + c.end - c.start, 0);
    out = out.slice(0, insert.at - shift) + insert.text + out.slice(insert.at - shift);
  }
  return out;
}

/**
 * Plan one workflow file. Never writes; `after` is the rewritten text for a
 * 'change'. 'skip' is reserved for files that do not parse.
 */
export function planWorkflow(
  file: string,
  text: string,
  opts: { cron: string; keepMergeGroup: boolean },
): WorkflowTriggerPlan {
  const base = { file, removed: [] as string[], kept: [] as string[], added: [] as string[], before: text };
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0) {
    return { ...base, name: null, action: 'skip', cron: null, reason: `does not parse: ${doc.errors[0]!.message}`, after: text };
  }
  const name = doc.get('name');
  const plan = { ...base, name: name == null ? null : String(name) };
  if (!isMap(doc.contents)) {
    return { ...plan, action: 'keep', cron: null, reason: 'no top-level mapping; nothing to change', after: text };
  }
  const onNode = doc.get('on', true);
  if (onNode == null) {
    return { ...plan, action: 'keep', cron: null, reason: 'no on: triggers found', after: text };
  }
  const { triggers, scheduleCrons } = inspectOn(onNode);

  const removed: string[] = [];
  const kept: string[] = [];
  const tagsOnlyPush = triggers.some((t) => classify(t.name, t.value, opts.keepMergeGroup) === 'keep-tags');
  for (const t of triggers) {
    const verdict = classify(t.name, t.value, opts.keepMergeGroup);
    if (verdict === 'remove') removed.push(t.name);
    else kept.push(t.name);
  }
  const addSchedule = removed.length > 0 && !kept.includes('schedule');
  const cron = scheduleCrons[0] ?? (addSchedule ? opts.cron : null);

  if (removed.length === 0) {
    const why = triggers.length === 0
      ? 'no triggers declared'
      : `kept: ${kept.join(', ')}${tagsOnlyPush ? ' (push is tags-only: still allowed)' : ''}`;
    return { ...plan, action: 'keep', removed, kept, cron, reason: `no per-PR or per-push trigger to remove — ${why}`, after: text };
  }

  const onPair = doc.contents.items.find((p) => scalarString(p.key) === 'on');
  const onKeyNode = onPair && isNode(onPair.key) ? onPair.key : null;
  const onKeyOffset = onKeyNode?.range?.[0];
  let after: string | null = null;
  if (isMap(onNode) && !onNode.flow && onKeyOffset != null) {
    after = spliceOnMap(text, onNode, onKeyOffset, removed, addSchedule ? opts.cron : null);
  }
  if (after === null) {
    // Scalar/seq/flow `on:` or a range-less node: rebuild via the node API.
    let target: YAMLMap;
    if (isMap(onNode)) {
      for (const trigger of removed) onNode.delete(trigger);
      target = onNode;
    } else {
      const rebuilt = doc.createNode({}) as unknown as YAMLMap<unknown, unknown>;
      for (const trigger of kept) rebuilt.add(new Pair(new Scalar(trigger), null));
      doc.set('on', rebuilt);
      target = rebuilt;
    }
    if (addSchedule) {
      const cronNode = new Scalar(opts.cron);
      cronNode.type = Scalar.QUOTE_DOUBLE;
      const entry = doc.createNode({}) as unknown as YAMLMap<unknown, unknown>;
      entry.set('cron', cronNode);
      const schedule = doc.createNode([]) as unknown as YAMLSeq<unknown>;
      schedule.add(entry);
      target.set('schedule', schedule);
    }
    after = doc.toString();
  }
  const added = addSchedule ? ['schedule'] : [];
  const parts = [
    `removed ${removed.join(', ')}`,
    `kept ${kept.join(', ') || 'none'}${tagsOnlyPush ? ' (push is tags-only: still allowed)' : ''}`,
  ];
  if (addSchedule) parts.push(`added schedule "${opts.cron}" (daily run replacing per-push/PR coverage)`);
  return { ...plan, action: 'change', removed, kept, added, cron, reason: parts.join('; '), after };
}

type DiffOp = { tag: ' ' | '-' | '+'; line: string };

function splitLines(text: string): { lines: string[]; noEol: boolean } {
  const lines = text.split('\n');
  const noEol = lines[lines.length - 1] !== '';
  if (!noEol) lines.pop();
  return { lines, noEol };
}

function lcsOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length, m = b.length, w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ tag: ' ', line: a[i]! }); i++; j++; }
    else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) { ops.push({ tag: '-', line: a[i]! }); i++; }
    else { ops.push({ tag: '+', line: b[j]! }); j++; }
  }
  while (i < n) ops.push({ tag: '-', line: a[i++]! });
  while (j < m) ops.push({ tag: '+', line: b[j++]! });
  return ops;
}

/** Line diff: common prefix/suffix trim, LCS on the changed middle. */
function diffOps(a: string[], b: string[]): DiffOp[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const mid = am.length * bm.length <= LCS_LIMIT
    ? lcsOps(am, bm)
    : [...am.map((line): DiffOp => ({ tag: '-', line })), ...bm.map((line): DiffOp => ({ tag: '+', line }))];
  return [
    ...a.slice(0, head).map((line): DiffOp => ({ tag: ' ', line })),
    ...mid,
    ...a.slice(a.length - tail).map((line): DiffOp => ({ tag: ' ', line })),
  ];
}

/** Unified diff for one file, `a/`/`b/` prefixed, hunks git apply accepts. */
export function unifiedDiff(file: string, before: string, after: string): string {
  if (before === after) return '';
  const a = splitLines(before), b = splitLines(after);
  const ops = diffOps(a.lines, b.lines);

  // Group change ops into hunks, merging across gaps of at most 2*CONTEXT context lines.
  const hunks: { start: number; end: number }[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.tag === ' ') { i++; continue; }
    let end = i;
    let j = i + 1;
    while (j < ops.length) {
      if (ops[j]!.tag !== ' ') { end = j; j++; continue; }
      let gap = 0, k = j;
      while (k < ops.length && ops[k]!.tag === ' ') { gap++; k++; }
      if (k < ops.length && gap <= 2 * CONTEXT) { j = k; continue; }
      break;
    }
    hunks.push({ start: i, end });
    i = end + 1;
  }

  // Last op index consuming each side's final line, for no-EOL markers.
  let lastA = -1, lastB = -1;
  ops.forEach((op, k) => { if (op.tag !== '+') lastA = k; if (op.tag !== '-') lastB = k; });

  let out = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n`;
  let aPos = 0, bPos = 0, cursor = 0;
  for (const hunk of hunks) {
    const s = Math.max(cursor, hunk.start - CONTEXT);
    const e = Math.min(ops.length, hunk.end + 1 + CONTEXT);
    for (let k = cursor; k < s; k++) { if (ops[k]!.tag !== '+') aPos++; if (ops[k]!.tag !== '-') bPos++; }
    const slice = ops.slice(s, e);
    const aCount = slice.filter((o) => o.tag !== '+').length;
    const bCount = slice.filter((o) => o.tag !== '-').length;
    out += `@@ -${aCount > 0 ? aPos + 1 : aPos},${aCount} +${bCount > 0 ? bPos + 1 : bPos},${bCount} @@\n`;
    for (const [idx, op] of slice.entries()) {
      out += `${op.tag}${op.line}\n`;
      const k = s + idx;
      if ((a.noEol && k === lastA && op.tag !== '+') || (b.noEol && k === lastB && op.tag !== '-')) {
        out += '\\ No newline at end of file\n';
      }
    }
    for (let k = s; k < e; k++) { if (ops[k]!.tag !== '+') aPos++; if (ops[k]!.tag !== '-') bPos++; }
    cursor = e;
  }
  return out;
}

/** Minute of the staggered nightly slot for the i-th of n scheduled additions. */
export function staggeredCron(index: number, total: number): string {
  const minute = total <= 1
    ? DAILY_MIN_FIRST
    : DAILY_MIN_FIRST + Math.round(((DAILY_MIN_LAST - DAILY_MIN_FIRST) * index) / (total - 1));
  return `${minute} ${DAILY_HOUR_UTC} * * *`;
}

/**
 * Plan the whole workflows folder. `files[].file` is the repo-relative path so
 * the patch applies at the worktree root. Default crons spread 09:03–09:30 UTC
 * across the files that need one, deterministic by file name order.
 */
export function planCiDaily(
  files: Array<{ file: string; text: string }>,
  opts: { cron?: string } = {},
): CiDailyPlan {
  const sorted = [...files].sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0));
  let plans = sorted.map((f) =>
    planWorkflow(f.file, f.text, { cron: opts.cron ?? FALLBACK_CRON, keepMergeGroup: true }));
  if (opts.cron === undefined) {
    const needy = plans.filter((p) => p.added.includes('schedule'));
    plans = plans.map((plan) => {
      const index = needy.indexOf(plan);
      if (index < 0) return plan;
      const source = sorted.find((f) => f.file === plan.file)!;
      return planWorkflow(source.file, source.text, { cron: staggeredCron(index, needy.length), keepMergeGroup: true });
    });
  }
  const patch = plans.filter((p) => p.action === 'change').map((p) => unifiedDiff(p.file, p.before, p.after)).join('');
  const counts = { change: 0, keep: 0, skip: 0 };
  for (const p of plans) counts[p.action] += 1;
  const summary = `${plans.length} workflow file(s): ${counts.change} change, ${counts.keep} keep, ${counts.skip} skip` +
    (counts.change ? `; patch rewrites ${counts.change} file(s)` : '; nothing to apply');
  const followUps = [
    "Required status checks: once ci.yml no longer runs on pull_request, the 'Merge Gate' required check never completes on a PR. Branch protection (ruleset and/or classic) must stop requiring it — or merges wedge — and the fleet's host merge path becomes the gate: src/core/fleet/host-merge.ts waits on the host-verified required check 'ashlr/verify' posted by src/core/fleet/verify-check-run.ts. Make 'ashlr/verify' the required check on master instead of 'Merge Gate'.",
    "Read-only look at the required checks currently on master: gh api 'repos/{owner}/{repo}/rules/branches/master' --jq '[.rules[] | select(.type==\"required_status_checks\")]'   (classic protection view: gh api 'repos/{owner}/{repo}/branches/master/protection/required_status_checks')",
    "Apply with: ashlr fleet ci-plan --patch | git apply   — then commit the .github/workflows change by hand; the fleet cannot touch the hidden GitHub folder.",
  ];
  return { plans, patch, summary, followUps };
}

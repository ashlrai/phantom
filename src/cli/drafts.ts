/**
 * `phm drafts list|show|approve|reject [--json]`: outbound drafts waiting for the owner.
 * Thin handler; the store and rules live in src/core/cos/drafts.ts. Approve records
 * the decision only and never sends. See docs/DRAFTS.md.
 */
import { approveDraft, DraftError, DRAFT_STATUSES, getDraft, listDrafts, rejectDraft, type Draft, type DraftStatus } from '../core/cos/drafts.js';

const USAGE = `phm drafts list [--status pending|approved|rejected] [--json]
phm drafts show <id> [--json]
phm drafts approve <id> [--digest <prefix>] [--json]
phm drafts reject <id> [--json]
Drafts: ~/.ashlr-runs/drafts/drafts.jsonl. Approve records your decision and does not send. See docs/DRAFTS.md.`;

/** Metadata only: list output never carries the body. */
const summary = ({ body: _body, ...rest }: Draft) => rest;

export async function cmdDrafts(args: string[], deps: { runsDir?: string } = {}): Promise<number> {
  const json = args.includes('--json');
  const emit = (value: unknown): void => console.log(JSON.stringify(value, null, 2));
  const flagValue = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const valueIdx = new Set(['--status', '--digest'].map((f) => args.indexOf(f) + 1).filter((i) => i > 0));
  const rest = args.filter((a, i) => !['--json', '--status', '--digest'].includes(a) && !valueIdx.has(i));
  const [verb, id, ...extra] = rest;
  const usage = (): number => {
    if (json) emit({ ok: false, error: 'Use phm drafts list|show|approve|reject --json' }); else console.error(USAGE);
    return 2;
  };
  if (!verb || ['help', '--help', '-h'].includes(verb)) {
    if (json) emit({ usage: USAGE }); else console.log(USAGE);
    return 0;
  }
  const status = flagValue('--status');
  const digest = flagValue('--digest');
  const known = ['list', 'show', 'approve', 'reject'].includes(verb);
  const needsId = verb !== 'list';
  const badShape = extra.length > 0 || (needsId ? !id : id !== undefined)
    || (status !== undefined && (verb !== 'list' || !(DRAFT_STATUSES as readonly string[]).includes(status)))
    || (digest !== undefined && verb !== 'approve')
    || rest.some((a, i) => i > 0 && a.startsWith('-'));
  if (!known || badShape) return usage();

  try {
    if (verb === 'list') {
      const drafts = await listDrafts({ runsDir: deps.runsDir, status: status as DraftStatus | undefined });
      if (json) emit({ ok: true, drafts: drafts.map(summary) });
      else for (const d of drafts) console.log(`${d.id}  ${d.status}  ${d.to}  ${d.subject}`);
      return 0;
    }
    if (verb === 'show') {
      const draft = await getDraft(id!, deps.runsDir);
      if (!draft) throw new DraftError('No such draft.');
      if (json) emit({ ok: true, draft });
      else console.log(`${draft.id}  ${draft.status}\nTo: ${draft.to}\nSubject: ${draft.subject}\nDigest: ${draft.digest}\n\n${draft.body}`);
      return 0;
    }
    const draft = verb === 'approve'
      ? await approveDraft(id!, { runsDir: deps.runsDir, digest })
      : await rejectDraft(id!, { runsDir: deps.runsDir });
    if (json) emit({ ok: true, sent: false, draft: summary(draft) });
    else console.log(`${draft.id}  ${draft.status}${verb === 'approve' ? '  (recorded, not sent)' : ''}`);
    return 0;
  } catch (e) {
    const message = e instanceof DraftError ? e.message : 'Draft store unavailable. See docs/DRAFTS.md.';
    if (json) emit({ ok: false, error: message }); else console.error(message);
    return 1;
  }
}

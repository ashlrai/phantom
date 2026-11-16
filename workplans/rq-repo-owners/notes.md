# Notes: repository ownership

- Canonical fleet repos from contrib/mac/dispatchd.py: phantom, phantom-secrets, locus, lexicon, ashlr-md, ashlr-stack, ashlr-plugin.
- Existing participant contract: src/core/agents/bus-v2-schema.ts.
- Existing durable bus: src/core/fleet/bus-inbox.ts. Use context receipts to register responsibility and work.post for advisory assignments, with no dispatch block.
- Existing exclusive resource lease table: src/core/agents/claim-store.ts. Never store or print its fencing material in reports.
- ready.tsv columns: job, repo, lane, tier, prompt path, optional market metadata. Lane is a routing hint, not owner evidence. Skip parked rows.
- Connected GitHub search found no open PR matching RQ-REPO-OWNERS in ashlrai/phantom.
- Host fleet paths are unavailable in this execution context; real orphan counts require an accessible metadata capture. Treat the shared fleet context as a partial snapshot only.

## Final observations
- Six GitHub issue-search pages produced 577 unique open PR identities across 22 repositories. The reported total changed from 577 to 578 while paging, so the capture is partial.
- The default durable bus was readable (587 live receipts at the measured check); the coordination table was missing, and acquisition returned unavailable. No live registration or assignment was accepted.
- The registration-only mode successfully registered all 22 seed roles on a private temporary fixture bus.
- Final regression suite: 19 passed. CODEOWNERS: 6 passed. Closure: 3 passed / 1 failed. Apps boundary: 1 passed / 2 failed.
- Missing closure entries: src/api/bot-templates.ts, src/core/agents/agent-profile.ts, src/core/agents/bot-templates.ts, src/core/drive/nodes/capacity.ts, src/core/drive/nodes/profiles.ts.
- Existing apps boundary includes apps-recovery-glance/history/invocations/verdict.ts. No pre-existing source file changed, so the existing runtime import graph is unchanged by this patch.
- Full lint errors are confined to src/core/agents/bot-templates.ts, src/web-ui/routes/verse/fleet-board/work-result-form-340.test.tsx, test/claim-execution-repository-binding-425s.test.ts, and tmp_fleet-recheck.ts.

# Weekly deletion sweep

From a Phantom checkout with `npm ci` complete, run `phm sweep report` or
`node scripts/must-earn-its-place.mjs`. Add `--repo <directory>` to inspect a
fixture or another local checkout. Run it weekly using your existing scheduler;
the command itself does not install a schedule. It overwrites only
`reports/deletion-sweep.md` and never removes code or changes rules.

The report scores named TypeScript and JavaScript exports and function routines,
plus headings and list items in `ENGINEER-RULES.md`, nonempty lines in
`agent-rules.txt`, and headings in `router-queue.md`. For rules and prompts, record evidence on the same
line using `last-used: YYYY-MM-DD` and `outcome: success|failure|unknown`.
Absent evidence is unknown. Git file changes are a maintenance signal, not
proof of use or success. The report explains its score and the limits of its
static analysis. Review every proposal, particularly public APIs, dynamic calls,
security rules and instructions that apply only during infrequent incidents.

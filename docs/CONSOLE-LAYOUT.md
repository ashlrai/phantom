# Console layout: one screen, three widths

The web console picks one of three layouts from the window width. The numbers
live in one place, `src/web-ui/app/console-mode.ts`
(`CONSOLE_LAYOUT_BREAKPOINTS`), and are stamped on the page as
`data-console-layout`; the stylesheets read that attribute, so every console
surface changes shape at the same widths.

| Layout | Window width | What you see |
|--------|--------------|--------------|
| compact | under 720px | The phone view. Navigation folds into a top strip, the topbar drops its keycap hint, and every panel stacks in one column. |
| regular | 720px to 1919px | The laptop view. Sidebar on the left (drag its right edge to resize, 200 to 480px, default 240px, saved per browser), the panel column beside it. |
| wide | 1920px and up | The external-monitor view. The board centers and widens so panels spread across the screen instead of hugging one side. |

There is nothing to configure. Open the console on any screen and it picks
the layout:

```sh
phm serve
```

The same live state renders at every width: pool usage, burn and pace, daemon
state, and the machine's memory, swap and disk. Numbers come only from
recorded readings, plus the Devin pool's independent bounded live read (the
same custody-wrapped `devin-api-v3-org-cycle` reader the usage panel uses).
A reading that is missing, stale or unreachable prints `unknown`, never
an invented percentage, and no secret values are rendered.

The same numbers without a browser:

```sh
phm resource --json
```

Each pool row reports `status`, `pctUsed` and `paceRatio`; any reading the
store does not hold is `null` in JSON and `unknown` in the console and text
output. The console itself is the API: the panel reads `GET /api/resource`,
which is the same projection `phm resource` refreshes and prints.

For the desktop mission briefing over the same fleet state, see the Fleet
screen's mission pane and `phm fleet mission --json` (bc-124196c5). The
phone-class Verse app at `/verse/m/` is a separate surface with its own
pointer-and-size rule; it is not part of these width classes.

Home opens the live fleet view on a fresh desktop console. It refreshes every
15 seconds while visible and lists running work, recorded merges over the last
24 hours, blocked work and holds, and percentage used per resource pool with
recorded reset times. Home is also available from the tray; saved navigation
continues to reopen the last selected view. `phm status --json` returns the same
four-list projection without requiring a repository index. Missing readings
remain `null` in JSON and unknown in Home. Spent means subscription quota used,
not a monetary cost estimate. Resource collection and lane diagnostics remain
owned by their existing APIs.

The phone Home screen brings the fleet glance, links to active sessions,
Needs you approvals and the comms inbox, the leader order box, and the recent
merge list together. These links open the existing screens and preserve their
permissions and confirmation flows. The merge list uses the live fleet runs
read and shows unknown or unavailable data as such.

## Fleet telemetry and Show Mode

The Fleet screen includes a Resource & activity board. It refreshes lane and
activity projections every four seconds while visible. Lane rows show quota
remaining when observed, live jobs, queue depth and the source observation
time. The activity panel shows up to eight recent actions and five recent
merges. A failed refresh can leave the last reading visible; source state and
timestamps help distinguish recorded data from current evidence.

Choose **Show Mode** in the console navigation for an auto-advancing story of
recent activity and a merge ticker. Pause the story or advance it manually.
The underlying sources refresh every 15 seconds while visible; unavailable
sources are reported and activity may be incomplete or stale. Neither view
starts work or establishes that an outcome was shipped.

## Unified engineering surface audit (RQ-DESKTOP-UNIFIED-1)

Phantom desktop is the operator surface. Agents use the same typed projections
and control services through the CLI or the existing authenticated loopback API.
This inventory reflects the source paths, not a claim that a host has configured
all adapters or granted desktop access.

| Capability | Desktop surface and implementation | Typed API and agent command | Gap or boundary |
| --- | --- | --- | --- |
| Fleet jobs and queue | Home, Fleet runs and mission; `fleet-runs-api.ts` | `/api/verse/fleet/runs`, `/api/verse/fleet/runs/orders`; `phm fleet mission --json`, `phm fleet orders --json` | Missing observations remain unknown; a queued job grants no authority. |
| Lane steering | Fleet Lanes; `fleet-control-api.ts` | `/api/verse/fleet/control/lanes`; `phm fleet lanes --json` | Existing mutation token and lane policy apply. |
| Needs you | Fleet inbox, `UnifiedInboxCard`; `agent-bus-api.ts` | `/api/verse/agent-bus/needs-mason` and `/resolve`; `phm fleet needs --json` | Resolving records a reply on the bus; it does not execute an app action. |
| Owner conversation | Comms inbox and owner thread; `owner-thread-api.ts` | `/api/verse/comms/owner-thread` and `/status`; `phm comms thread --json`, `phm comms status --json` | The HTTP owner thread is read-only. Configured channel and send policy still govern outbound replies. |
| Allowlisted app operations | Fleet Host Allowed apps; `AllowedAppsCard.tsx`, `apps-control-api.ts` | GET/POST `/api/verse/apps/control`; `phm apps list --json`, `phm apps request focus Cursor --json` | Previously CLI-only policy is now shared. Empty allowlist permits nothing. Per-app actions and request mode apply to every caller. |
| App recovery diagnostics | Fleet Host Managed apps; `fleet-apps-api.ts` | `/api/verse/fleet/apps`, `/action`, `/recovery`; `phm fleet apps-status --json` | Existing fixed-catalog recovery is a separate host-script facility. It is not evidence of enrollment in the apps allowlist or a grant for general app control. |
| Phantom self-control | Allowed apps request mode and existing `createPhantomSelfDrive` session adapter | `/api/verse/apps/control` queues app-level requests; `/api/verse/sessions` backs typed session work | Phantom stays on the screen-control denylist. Quit/open/focus requests do not call the launcher or desktop tools. |
| Other app contents | Existing desktop task adapters and Browser pane | Task-specific desktop adapters retain their own grants | Apps control only opens, focuses, checks status, or safely quits. It cannot type, read messages, change TCC or approve its own grants. |

The Allowed apps card is available even when Fleet runs cannot be read. It shows
allowlist policy, running/frontmost state, unknown readings, request-only actions,
and needs-you results. It uses the same `runAppsControl` service as `phm apps`.
It neither starts another listener nor adds a transport. Browser app lifecycle
control does not grant browser input; browser interactions still use the Browser
pane. See [Apps control](APPS-CONTROL.md) for enrollment, copy-paste examples and
the fleet request/reply loop.

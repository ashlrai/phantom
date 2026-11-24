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

Home files its cards under two named groups. **Agents and machines** is who
is working and what needs you: Decisions, From your leader, Leader, Working
now, Running jobs, Machines, This Mac and Main. **Usage and delivery** is
what the work costs and what it produced: Pools, Most at risk of going
unused, Merged PRs, Shipped today, Work log and Disk. When the Home pane is
at least 64rem wide (1024px at the default text size) the groups sit side by
side as two columns, each card keeping its own height, and the Pulse rows run
across the top instead of down. In a narrower pane (Home beside an open
chat, or a small window) the groups follow each other in one column. The
pane's own width decides, not the window's. Keyboard and screen-reader order
is the same at every width: the first group, then the second. The layout
adds no request.

Home's **Running jobs** card is a tile per lane: the provider's mark and the
lane name, the number of jobs running, and one square per target slot, filled
for each running job (a lane with more than 24 slots draws one bar of the
same share). A lane with no recorded target says "no target" and draws no
squares; a lane running more than its target says how many are over. The
line above the tiles adds up jobs running, lanes busy and target slots
filled. Home's **Main** card is a mark per repository, red first, then
unknown (a hollow ring on a dashed outline), then green, under one line that
names the red ones. It says the default branches are green only when every
one is. Both draw the lists `phm home` prints and read nothing else.

Home's **Most at risk of going unused** card draws the allowance `phm home`
names: the provider's mark and the resource, the countdown to its reset with
the local time, the share projected to expire unused as the one figure, and
one bar of how the window ends. Left to right the bar is the share used now,
the share the measured burn adds by the reset (the same colour, lighter) and
the part left over (an empty track outlined in amber); a key under the bar
states each share and the burn an hour. The split comes from `usedPercent`
and `burnPctPerHour` in the summary's `atRisk` field; a server that does not
send them gets one "used by its reset" share, never a guessed split. A reset
time that has passed is said in words and not counted down. With nothing at
risk the card says so, and with no fresh reading it gives the reason.

Home's card column draws each reading beside the words that state it. The
headline has a state mark (green healthy, amber stalled, red main, a hollow
ring for unknown) and the time the summary was read underneath; if a refresh
fails, that line says the reading is an old one. Each pool has a thin bar of
the share used, and each lane with a recorded target has a meter of running
jobs against it. A pool with no reading gets a hatched bar and a lane with no
target gets none, so a missing number never looks like zero. Main lists one
mark per repository.

Home's **Pools** card is a resource bar: one tile per pool, as many across as
fit (two on a phone). A tile shows the provider's mark and the pool's name,
the share left as the large figure, how long the pool lasts at the measured
burn, when it resets, how its window ends at that burn, and a bar along its
bottom edge. The ending is the runway's own verdict: "70% unused at its
reset", "dry 46 h before its reset", "on pace to use it all", or "not
projected" with the reading that is missing. The bar is split the same way:
used so far is solid, what the burn uses before the reset is lighter, and the
gap after them is the share left unused; a pool that runs dry early fills to
the end in amber. A line under the tiles counts the pools by ending and
holds the key to the bars. The tile's bar, the Most at risk card's bar and
the bar on each Pools board card are one design-system component
(`components/primitives/WindowBar.tsx`), so a part looks and reads the same
on all three. A pool that
empties before it resets has its figure and that line in amber. A pool with
no reading says "usage unknown" in place of a figure and has a hatched bar,
and Local shows "free,
limited by memory" with no bar. The line under the title names the pool that
will not last to its reset (or counts them), counts pools without a usage
reading, and gives the soonest reset and the time the readings were taken.
Select a tile to list that pool's running jobs under the bar, below the
runway's advice for that pool; a job opens in the Worker log. **Open Pools** opens the Pools pane. The same readings for
agents:

```sh
phm pool runway --json
```

Home's **Working now** card answers "what is each agent doing?" without
leaving Home. It lists up to six worker sessions with repo, when each last
spoke and its last message: quiet ones first (no output for 10 minutes), then
the most recent, then any that failed in the last hour. Select a row to open
that session's messages in the Worker log, where pause and stop live; **Open
Sessions** opens the whole tree. It reads the same list as the Sessions pane
and refreshes every 15 seconds while visible. A repo, time or message the list
does not hold reads unknown, and a failed refresh keeps the last list and
says it may be stale. The same list for agents:

```sh
phm sessions --json
```

Home's **Machines** card is a tile per Mac in the pool, this Mac first. Each
tile gives the Mac's name, whether it is online, offline or unknown with a
mark beside the word, and when it was last seen. Below that come its free
slots as the large figure, memory as the free amount and the share in use
with a bar of that share, the jobs it is running, then load, free disk and
offload. On the desktop each running job is a button that opens that job's
messages in the Worker log; a tile names up to six jobs and counts the rest.
A line above the tiles counts the Macs that are online and the jobs running
on the Macs that report them. Nothing is estimated: unmeasured slots read
"free slots unknown" instead of a number, a Mac with no memory share gets a
hatched bar instead of an empty one, and an offline Mac's tile is dashed, with
when it was last seen in its head. The card refreshes every 30 seconds while
visible. The same report for agents:

```sh
phm nodes pool --json
```

Home's **Shipped today** card lists every pull request the fleet merged in
the last 24 hours, newest first. Two sentences lead: how many merged, across
how many repositories and at what rate, then the median time from open to
merge and the pull request that stayed open longest. When more than one
repository merged, a row of buttons (each with its count, underlined by its
share of the list) narrows the list to one; choose it again, or **All**, to
go back. Each row gives the merge time, the lane's provider mark, a link to
the pull request, the lane and the time it was open. Under the row a line
runs across the feed's own 24 hours: it starts where the pull request was
opened and ends in a dot at its merge, and fades in from the left edge when
it was opened before the window. When the feed names the job that made the
pull request, the job id opens that job in the Worker log. Nothing is filled
in: a row with no time open says "open time unknown" and gets a hollow dot
and no line, a missing lane reads "lane unknown", an incomplete feed counts
what it lists and says the totals are unknown, and no line is drawn when the
feed does not give its window. The card reads the feed again every 10
minutes while visible and says when a refresh failed. The same feed for
agents:

```sh
phm shipped --since 24h --json
```

Home's **Work log** card shows what the fleet did in the last 24 hours. One
sentence counts the events by kind: merged, launched, finished, no change,
leader and incident. Under it each kind that happened gets a row: its name
and count, a strip of 48 squares running across the report's 24 hours (a
filled square is a half hour in which that kind happened, darker where more
happened within that row) and the time it last happened. A kind's name is a
button that narrows the list below to that kind; choose it again to go back.
The list holds the newest eight events with the time, the kind, the lane's
provider mark and the event in words. A merge links to its pull request,
"3 times" marks a line that stands for repeated events of one job, and a job
id opens that job in the Worker log. Nothing is filled in: a source the
report could not read is named under the sentence as not counted, an event
with no readable time is listed as "time unknown" and gets no square, and no
strip is drawn when the report does not give its hours. The card reads the
report every minute while visible. Until the first read answers, or on a
server that does not serve the report, it lists the few newest lines the
Home summary carries. The same report for agents:

```sh
phm worklog --hours 24 --json
```

The Metrics pane is one board of the last 24 hours. It leads with the merged
PR counts and the busiest hour, then four numbers (the first with a line of
the merges in each hour), the two hourly charts side by side and a ranked bar
per repo the merges landed in. Next come two cards side by side. **Where the
loop waits** lists each stage of a job with its median and 90th percentile,
and under each stage name a bar of its median against the slowest stage's,
which is drawn in the warning colour; a stage no job gave a time gets a
hatched bar and the word unknown. Its **24 hours** / **7 days** switch sits on
the heading's line. **Merge leverage** says what share of the merges moved the
fleet or the product. Below sit one card each for lanes, spend-down, job
kinds, generators and releases. Lane and pool rows carry the provider's mark;
under a lane's merge rate a thin bar shows how its finished jobs ended
(merged, changed nothing, the rest). A lane or pool without a reading gets a
hatched bar and the word unknown, never a zero. The first read shows
placeholders, a failed one says the report is unknown with **Try again**, and
a failed refresh labels the board as the last reading. The numbers are the
ones these commands print:

```sh
phm metrics --json
phm metrics loop --json
phm metrics leverage --json
phm jobs yield --json
```

Home's Merged PRs card opens the Throughput pane. It leads with the report's
headline and a Delivery flow chart: jobs launched, PRs published and PRs merged
in the window, each with its exact count and its share of the step before. The
counts are what happened inside the window, not one batch followed through, and
the chart says so. Above it a row of figures gives launched, published, merged,
the share of finished jobs that changed nothing and the median time to merge,
each over a line of its own hours, with the busiest hour named. Under the two
hourly charts each lane has a card: the provider's mark, its merged count, a bar
against the lane that merged most, a row of bars for the jobs it launched
across the window and its launched, published, merge time and changed-nothing
readings. A figure the report does not hold reads unknown and has no line
under it.

Under the figures the fleet's own hours are drawn as the same row of bars: a
bar per hour, as tall as the jobs launched in it, with a mark under each bar
that had a PR merged. Over 7 days a bar covers 7 hours, as on the Models board.
Lane bars are drawn against the busiest bar on any lane, so the cards compare.
These rows are one reading cursor. Point at a bar, or focus a row and press
Left, Right, Home or End, and that stretch of time is held on the fleet row and
on every lane card at once: the figures above become that bar's own counts, the
line under the fleet row says when it was and what happened in it, and each
lane card says what that lane launched, published and merged. The median is
kept per hour only, so on a 7 hour bar that figure stays the window's and says
so. Esc, moving the pointer off the bars or moving focus off the rows lets go.
While no bar is held each row names its busiest bar. An hour the report holds
no count for is hatched, and a lane with no hours read gets no bars.
Pick 6 hours, 24 hours (the default) or 7 days; each choice
asks the same route `phm throughput --hours 168 --json` reads, so nothing is
summed in the browser. An unreadable metrics file shows unknown, a quiet window
shows an empty flow, and a failed refresh labels the reading as an old one.
The card on Home draws the last 24 hours from that same report under its three
figures (last hour, last 24 hours, median time to merge): one bar per hour of
PRs merged with the current hour in full colour, the busiest hour named in
words, the launched, published and merged counts in order, and one row per
lane that merged (up to five, most first) with the provider's mark and a bar
against the lane that merged most. An hour with no merge is a grey stub and an
hour with no count is a gap. If the report cannot be read the card says the
hourly merges are unknown and keeps its figures; a failed refresh keeps the
last drawing and gives the time it was read.

The Capacity pane is one board of how full the lanes ran against their slot
targets over 6, 24 (the default) or 72 hours. The headline is the share of
target slots that were filled, and the totals under it give idle slot time,
time on hold, time stalled (open slots with work queued) and how much of the
window the sampler was watching. Each lane is a card with its provider mark,
its fill, the running line over the dashed target with the first and last
sample times and the value of the top edge, and labelled readings: the last
sample, idle, held and, only when it happened, stalled. Lanes that stalled
come first, then the most idle. A lane with no target says "no target", not a
percentage.

Under its slot readings each card carries the lane's **usage window**, read
from the lane's own row of `phm pools --json` (`GET /api/app/pools`, the read
the Pools board and Home share): the share used, when it resets (as a
countdown and a local time) and how old the reading is, then the bar the
Pools board draws, with the mark for the time gone. One line under the bar
says how the window ends at the measured burn. When usage is set to go unused
and the lane also left slots open in the chosen window, that line names both
figures and turns amber, for example "68% set to go unused at the reset, and
4.5 slot-h of its slots sat open in the last 24 h." A window that runs empty
before its reset says when. A lane with no reading, a lane `phm pools` does
not list and a failed read all say "usage unknown" over a hatched bar and
give the reason; a lane with nothing metered says "no usage window" and a
credit lane gives its balance, both without a bar. A refresh that fails keeps
the last view and labels it "last reading". The words **Usage window** open
the Pools pane, and a key above the cards names the parts of the bar once a
card has a measured window.

The Launch gaps strip draws the window once: filled where samples
exist, amber where a launch gap was found, hatched where nobody was watching.
The charts share one cursor. Point at any lane's chart and the sample taken
nearest is marked on every lane at once, on the Launch gaps strip and on the
Workers / leaders chart: the line under each chart becomes that sample's time
and what the lane held then (`18 of 24 running, 8 queued, held`; a lane the
sample does not name is "not reported in this sample"), and the line above
the cards gives the fleet at that moment (slots running of target, lanes,
queued, lanes held, paused). Each chart is also a slider: with it focused,
Left and Right step one sample, Page Up and Page Down a tenth of the window,
Home and End jump to the oldest and newest, Esc lets go, and Tab to the next
chart keeps the moment. Nothing is drawn between samples.
Every figure is computed from the samples `GET /api/verse/runs-history`
returned, so unwatched time is never counted as idle or as full.

The Pools pane is one board of every resource pool, most at risk of going
unused first. Each card has the pool's plain-words line, a bar and labelled
readings. The bar is the one Home draws for a pool (solid: used so far;
lighter: what the current burn adds by its reset; an empty stretch outlined
in amber: the share left unused at the reset), with a mark for the time
elapsed in the window; a pool the view tells to slow down fills in amber, a
pool with no usage reading is hatched, and a key under the cards names each
part. The readings: used, left, the reset as a countdown and a
local time, burn per hour and its basis, unused at reset, jobs running against
the slot target, and how long ago the reading was taken and by which reader.
Under the bar, a plan pool draws its window so far: every stored reading from
the window's start to its reset, the dashed even line from 0% to 100%, a rule
at now and a dotted line from the newest reading to where the card says this
burn ends. The sentence below it counts the readings and gives the newest one
against the even line in points. One reading is one dot, a pool without a
reset time says its window cannot be drawn, and when the stored readings
cannot be read the board says so once and draws no chart. Each reading can
be read on its own: point at the plot for the reading drawn nearest, or focus
the plot and press Left or Right to step through them (Home and End jump to
the oldest and newest, Esc lets go). A rule and a ring mark the reading, and
the sentence below becomes its time, its used share and where the even line
stood then.
Claude's per-model weekly windows sit under its card. A credits pool shows its
balance and no bar. The line under the headline names the next reset, and the
switch narrows the list to Behind, On pace or Unknown (arrow keys move it).
Above the switch, **Runway ahead** puts every plan pool on one line of time
from the reading to the furthest reset, soonest reset first: a line to the
pool's reset with a ring at it, the countdown and local time, and what the
view projects in words. A pool that runs empty first stops where
`projectedEmptyAt` says and the wait from there to its reset is hatched
("empty in 10 h, then dry 2 d 2 h until reset"), amber only where the pool's
own verdict is slow down or fully used. A pool with no usage or burn reading
is dashed and says so, a held lane says held, and neither is projected.
Claude's per-model windows follow their pool with their reset and usage only.
Credit balances, lanes without a window and resets that have passed are named
under the line with the reason. A pool's name is a button: it brings that
pool's card into view and puts the keyboard on it, showing it again if the
switch had hidden it. With no reset ahead the section is not drawn.
Every value is read from `pools.v1`; one it does not hold reads unknown, never
zero. The same rows and the same stored readings for agents:

```sh
phm pools
phm fleet usage-history
```

The Models pane is one board of every model the router knows, grouped under
each provider's mark. A model's card says whether the router would launch it
and why not when it would not, then lists the lanes that name it with the tiers
that pick it, the last launch that used it, the date official docs last
confirmed the name, and the source page. Verify (or Check again) on the card
re-reads that page. At the foot of the card is the work that model did: one row
of bars for the jobs launched on it across the last 24 hours (a bar an hour) or
7 days (a bar per 7 hours), a mark under each bar in which a PR merged, and the
counts in words (jobs launched, PRs merged, finished jobs that came back
empty). Every card is drawn against the busiest bar on the board, so cards
compare, and each provider's heading totals its models' launches. A job counts
for the model its launch row names. A model with nothing recorded shows an
empty line and says so; when the report cannot be read every card is hatched
and reads "work unknown", never zero. Launches whose record names no model are
counted in a sentence above the cards and for no card, and names jobs launched
under that the registry lacks are listed after the providers. The bars are also
a reading cursor shared by the whole board: point at one bar, or focus a row
and press Left or Right (Home and End jump to the oldest and newest bar), and
that stretch of time is held on every card, each card's words become its own
jobs launched and PRs merged in it, and the line above the cards gives the
fleet's counts for it from the report's own hours. Esc, moving the pointer off
the bars or moving focus off the rows lets go. The switch narrows the board to Needs attention or Routable
(arrow keys move it), and models the provider docs name that the registry lacks
are listed at the end. The registry, the check and the lane model table are
read separately: when one cannot be read the board says which, and the facts it
would have held read unknown rather than zero or routable. The same rows for
agents:

```sh
phm models --json
phm models check --json
phm throughput --by model --json
```

The Lanes pane is one board of every lane's slots. The headline counts slots
running against slots asked for and how many lanes are held; the line under it
gives merges in the last hour and the dispatcher's last tick, each reading
unknown when the snapshot does not hold it. A strip lays every lane's slots end
to end, a segment as wide as the lane's target and filled by what is running.
Each lane is a card: its provider mark and name, a Down or Held badge or the
state in words (Full, how many open, how many over target, Target 0), one
square per slot (filled when a worker holds it; a lane with more than 32 slots
draws one bar instead), the running/target and queued counts, and labelled
readings for tokens in the last hour, merges in 24 hours and merge rate, where
a missing reading says unknown, never zero. The target stepper, Pause and the
hold release sit under the readings. The same data for agents:

```sh
phm fleet runs --json
```

The Supply pane is one board of how many job files to write so the lanes stay
full. The headline gives the count, the line under it what opens in the next
15 minutes and what is waiting for it, and a strip lays every lane's opening
slots end to end, filled where a job waits. Each lane is a card: provider mark,
the state in words (N short, Supplied, No slots opening, or Held with when it
comes back), one square per opening slot (filled when a job waits for it,
dashed when nothing does) and labelled readings for running against target,
free now, freeing soon, waiting and shortfall. The lane name opens Lanes and a
run-out time opens Usage. When the drop folder cannot be read, the pending
files are unknown rather than zero: the card counts queued jobs only and each
shortfall reads "up to N". Under the cards, the waste forecast draws each
weekly window at reset (used, what the current burn adds, hatched for what
goes unused) beside the target that would use it. Slots and waiting jobs come
from the read `phm fleet runs --json` prints; run-out times and the forecast
from the leader's resource ledger.

The Usage pane is the provider-account side of the same picture: one card per
signed-in account (Claude, Codex, Grok) with its brand mark, plan and exactly
the windows the provider reported. The headline counts where the accounts
stand (flagged at a limit, not readable, still checking, no reading) and the
line under it names the next reset. A limit is counted only when the provider
flagged it, never from a 100% reading, because credits can keep that account
usable. Each window shows its bar, percent and reset as a countdown plus a
local clock time; Claude's reset is the provider's own sentence, so no clock
time is derived for it. A window with no reading has a hatched bar, not an
empty one. The bar is the same one the Pools board draws, and it is never
coloured for being high: a limit is the provider's flag, drawn as its own full
bar. Where the accounts read holds the window's start, the bar carries a mark
for how much of the window's time has gone and a line under it gives that
share, how many points use sits behind or ahead of an even spend, and when the
window began. The start is the provider's own (Grok's billing period) or seven
days before a reset the server confirmed as weekly, and the line says which. A
window whose start the read does not hold has no mark and no pace line; nothing
is projected here, because this read has no burn rate (the Pools board has).
Above the cards, Resets ahead puts every window that gave its reset
as a date and time on one line that starts at now, soonest first: the wait
drawn to a dot at the reset, the countdown and local time, and the usage now
in words (a percent, "limit reached" with a square in place of the dot, or
"usage unknown"). The scale is hours from now on a line shorter than a day
and a half, local midnights beyond. The fleet's own Codex personal reading
joins the line when the fleet read carries its reset. A window with a sentence
for a reset, with none, or with one that has passed is named under the line
with that reason and gets no position; with no dated reset at all the line is
not drawn. Tokens last hour totals the lanes that reported a figure, says how
many did not, and draws each lane as a thin bar against the busiest lane.
Accounts come from `GET /api/verse/accounts` and lane tokens from
`GET /api/verse/fleet/runs`. `phm usage limits [--json]` prints the same
accounts, headline and next reset in a terminal; one core module
(`src/core/usage/account-limits.ts`) computes them for both.

The Router pane answers "where would each kind of work go, and why?". Its route
table has a row per task (code, review, plan, bulk, leader) and a column per
difficulty; each cell names the seat the router would send that work to first,
with the provider's mark and the seat it would try next, and a line above
counts the cells by first seat. A cell reads "No seat" when nothing is
eligible and "Unknown" when the router sent no answer for it, and a line says
how many cells went unanswered. Each cell is one read of
`GET /api/verse/budget/preview?task=&difficulty=&autonomous=`, the router's own
unlogged preview, so filling the table records no decision; "Your request"
asks the same fifteen previews for interactive work instead of autonomous
fleet work. Choose a cell (click, or arrow keys then Enter; Home and End jump
along the row) to draw its answer as a numbered try order. Each seat has a bar
of the share of its binding usage window already used and that window's reset
time; seats the router holds back are listed underneath with its reason and
when they become eligible again. The bar is the shared window bar: its fill is
the share used and takes no status colour for a high reading.

Under the try order, "Seats the router balances across" turns the same table
on its side: one row per seat that the budget reading or any answered cell
names, the seat that is first choice for the most kinds of work at the top. A
row holds the provider's mark and the seat's name, a count in words (`First
for 9 of 14, held back from 4`, out of the cells the router answered), and
fifteen cells in five groups, one group per task reading low, medium, high. A
filled cell is a first choice, an outlined cell with a number is a later try
and its place in the order, a dashed cell is held back (its label and tooltip
carry the router's reason), a faint cell is a kind of work the router
answered without naming the seat, and a hatched cell is a kind it gave no
answer for. Under the cells are the usage windows `GET /api/verse/budget`
holds a percent for (session, weekly or both), each as a window bar; the one
fleet work is measured against is marked "binds fleet work" with its reset,
the only reset that read reports. A seat with no reading gets a hatched bar
and "Usage unknown", a local seat "Local: no usage window". The last line is
what the budget reading says about fleet work on the seat: open (with the
share of the binding window it may still use when the reading has one),
closed with the reading's reasons, or unknown when the reading does not name
the seat. The kind of work chosen in the route table is ringed down every
row, and choosing a cell on the board chooses that kind in the table. The
board is one tab stop: Left and Right walk a seat's kinds of work, Up and
Down keep the kind and change seat, Home and End jump along the row, Enter
chooses. It adds no request.

Below, the last 200 recorded routing
decisions are counted by chosen seat and drawn over time: one row per seat,
most chosen first, each holding a lane of 24 columns that cut the span from
the oldest decision read to now into equal slices. A column's height is how
many decisions chose that seat in that slice, every lane against the same
tallest cell so lanes compare, and an amber cap marks a slice whose work ran
on a different seat than the one chosen. The span never reaches back past the
oldest decision read, and a decision whose time cannot be read is counted in
words and not drawn (with no readable time at all, the rows keep plain share
bars). Point at a column to read it: the line under the chart gives its start
and end, its count, the seats chosen in it and how many ran elsewhere, and
the list below becomes that column's decisions (six shown, the rest
counted) instead of the six newest. The time axis under the lanes is one tab
stop: Left and Right step a column, Home and End jump to the oldest and
newest, Esc lets go, and a click keeps a column until focus leaves. A decision is the
seat the router chose, not proof the work ran there. The pane decides nothing
and launches nothing: besides the previews it reads `GET /api/verse/budget`
(seat usage, resets and the time that usage was read) and
`GET /api/verse/budget/decisions`, and refreshes every 30 seconds while
visible. A seat with no usage reading gets a hatched bar and the word unknown,
a local seat says it has no usage window, an unreadable decision log reads
unknown rather than empty, and a failed refresh labels the reading as an old
one.

Home's **Blocked** card, before Pools in Usage and delivery, answers
"what is stopping work?". One headline counts it. Below are
the reason launches are paused and how long nothing has
launched, each repository hold with its reason and when it
lifts, each lane whose jobs wait with nothing running (select
one to open Lanes on that lane) and the parked-job count.
**Open Lanes** is its one action. It reads the live fleet
status and the launch-stall view the Lanes pane already uses,
every 30 seconds while visible, and changes nothing. The card
waits for both reads, so half an answer never says "Nothing
is blocked". A reading that could not be made is listed as
unknown with its reason, and the headline then says only that
nothing is recorded as blocked. A failed refresh keeps the
last reading and says it may be stale. `phm status --json`
lists the same repository holds.

The Releases pane leads with one sentence: how many commits are waiting for a
release and in how many repos. Under each repo it draws the release path as
four stations, left to right: Unreleased (commits since the newest tag),
Release PR (its number and whether checks are green, running or blocking, a
merge conflict or a version downgrade), Release run (the latest release
workflow's result and age) and Published (the newest published tag, marked
when it is a draft or prerelease). Each station's mark repeats its words:
green done, amber waiting, red blocked, grey for a recorded nothing such as no
PR open. A station the reads do not hold (GitHub offline, the release PR read
failing, an older server without commit counts) is a hollow ring that says
unknown, never zero or none. The path reads `GET /api/verse/ops/releases` and
`GET /api/verse/release-pr`; the release PR's checks, notes and merge button
stay underneath.

Feed puts what the fleet did in one newest-first stream: merged PRs (title and
repo), published releases, failures (main going red, a job failing or ending
empty with its reason when known), lanes (a lane hitting its plan limit, being
paused, reset or running again, in plain words with the recorded line as
`detail`), incidents (dispatch incidents, stopped and parked jobs) and Leader
replies. Each card has a kind icon, a relative time and one link. Three or more
merges in one repo in one clock hour are one card (“12 PRs merged in phantom in
the last hour”) whose `group` lists them one tap away.
`phm feed --json --since 1h --kind merged` and
`GET /api/feed?since=1h&kind=merged` return the same `phantom.feed.v2` report
(`version: 2`, `items`, `more`, `next`, `sources`); `--since` takes 1m to 7d or
an ISO time within seven days, and `--limit` takes 1–1000 (default 30). `next`
is the cursor: pass it back as `since` to read only newer events. The pane's
kind filter and “Load more” call the same route. Per-tick dispatcher noise
(`EMPTY_SIGNAL`, `LOADGATE warn`) is dropped, and a notice that repeats is one
card with a count. The Feed reads existing journals only (jobs ledger,
dispatch events, Leader plan log, outbox, guardian state); missing sources stay
unknown. Main recoveries and incident closures have no recorded time, so only
red and opened are shown. Empty reads
show “Nothing new yet.”

The resource boards are one surface. Pools, Usage, Router, Models, Lanes,
Capacity and Supply each open with the same row of names across the top, in
that order: what the fleet has, where work is sent, how the lanes are running.
The board on screen is marked. Choosing another name puts that board in the
same dock tab, so looking across them does not pile up tabs; a board that
already has a tab of its own is brought forward instead. The row is one Tab
stop: Left and Right move along it, Home and End jump to the ends, and `[` and
`]` step to the previous and next board from anywhere in the board except a
text field. The row stays in view while the board scrolls. It lists only the
boards this build has, and it is not drawn while the dock is tiled as the agent
workspace.

Every name in the row can carry a live reading, so the row is the status line
of the whole surface and says where to look before a board is opened. Pools shows how many pools will run empty before
their reset (`2 too fast`), else how many are behind their window, else how
many have no current reading, counted from the `phm pools` view. Usage shows
how many accounts their provider flags at a limit (`1 at limit`), else how
many could not be read, counted from the Usage board's accounts read the way
`phm usage limits` counts them; an account at 100% without the provider's flag is not
counted. Lanes shows how many lanes are held, or slots running over slots
asked for (`5/6`) when none is held, counted from `phm fleet runs`. Router
shows how many kinds of fleet work no seat can take right now (`2 no seat`),
else how many the router gave no answer for, counted from the Router board's
route table. Models shows how many models the router refuses
(`1 not routable`), else how many are stale or deprecated in their provider's
docs (`2 to review`), counted from `phm models` and `phm models check`; a
retired model is not counted. Capacity shows the share of target slots the
lanes kept filled over the last 24 hours (`83.3% filled`), the board's own
figure, and nothing for a window nobody sampled. Supply shows how many slots
opening in the next 15 minutes have no job waiting (`3 short`), from the same
snapshot Lanes reads; when the drop folder could not be read the figure is an
upper bound and says so (`up to 3 short`).

Each reading comes from the same read its board draws from, refreshed while
the row is on screen (Pools, Lanes and Supply every 30 seconds; the others
every 60), and the board's own headline is the name's tooltip. Amber marks a
reading that asks to be looked at; a plain figure is only a figure. A board
with nothing to flag, or whose read has not answered or last failed, shows no
reading: the name stands alone, never a zero.

The phone Home screen brings the fleet glance, links to active sessions,
Needs you approvals and the comms inbox, the leader order box, and the recent
merge list together. These links open the existing screens and preserve their
permissions and confirmation flows. The merge list uses the live fleet runs
read and shows unknown or unavailable data as such.

The Leader chat shows where each of your messages went. Under a message that
became work sits a routing trail: one row per job whose prompt cites the
message, with the lane it was routed to, a four-step track (queued, launched,
published, merged) and the recorded result. On a job that has launched, the
id opens its Worker log and "Conversation" opens what that session was told,
said and did without leaving the Leader pane: beside the chat when the pane
is wide enough, over it otherwise. The row is lit and its button reads
"Conversation open" while that session is the one open, and closing it (Esc)
puts the keyboard back on the button. A published or merged job links its
PR. A job that ended with nothing to publish says so. A message from the last
six hours that no job cites reads "Not routed to a lane yet". If the job
prompts could not be read it reads routing unknown instead, and a job with no
recorded lane reads "lane unknown". The toolbar counts the routed jobs still
in flight, or says "Routing unavailable" when the trace does not answer. The
trail reads `GET /api/verse/leader/orders`, the same order trace as:

```sh
phm fleet orders --json
```

A job the Leader names in one of its own messages is live too. Under the
message, each named job is one chip: a dot and words for what that session is
doing now ("running · claude · spoke 2m ago", "quiet 14m", "finished",
"failed"), the last thing it said while it is working, and Log for its Worker
log. The job id opens the session as a conversation in the same place a
routed job's does, and is underlined while it is the one open. A job the
session list does not hold reads "not in the session list" and is never
called finished; when the list cannot be read every chip reads "state
unknown". Pull requests the message names stay links on their own line. The
chips read the list the Working now strip already reads, so they add no
request:

```sh
phm sessions --json
```

## Fleet telemetry and Show Mode

The Fleet screen's read-only **Fleet map** places agent sessions inside their
observed machine zones. Select a machine or session to open its detail sheet;
session details include a job permalink and a PR link when recorded. Unplaced
or conflicting sessions remain visible in a separate zone. Recently finished
sessions are available below the map.

Compute and session observations refresh every four seconds while visible.
Each source shows its update age; failed refreshes retain a labeled last reading.
CPU percentages require two advancing samples. Machine readings older than
90 seconds become unknown. Heat uses claimed slots divided by the fresh
advertised slot ceiling; the RAM-derived ceiling is labeled separately and
never substituted. Unknown capacity uses a dashed zone without a gauge.
The current session projection has no callsigns or owned-file lists: these
remain unknown. Below the machines, **Messages** lists who messaged whom in the
last 15 minutes as lines between organizations (the company behind each
agent's lane), with the agents on each line, message counts and the last
message time. It shows names and counts only, never message text, and reads
`GET /api/fleet/message-graph`, the same read as
`phm fleet message-graph --json`.
The map uses the console's compact, regular and wide layouts.

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

Company opens with org member counts, members with recorded lane opt-ins, distinct
contributed lanes, fleet jobs running and merges today (Eastern Time). The org
summary reads the same declaration and join records as `phm org show`, and exposes
counts only. Declared capacity without a positive opt-in contributes no lanes;
unreadable records leave contributions unknown. Fleet totals remain shared
aggregates, separate from member activity and private account usage. Sources
refresh every 15 seconds while visible; missing org metadata stays unknown.

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
| Known Mac apps | Fleet Host Apps; `MacAppsCard.tsx`, `apps-known.ts`, `apps-control-api.ts` | GET `/api/verse/apps/mac`, POST `/api/verse/apps/control`; `phm apps --json`, `phm apps open claude --json` | One row per app, one button (Open or Bring to front). No quit button; quit refuses all but Safari. |
| Agent browser (Safari) | Fleet Host Browser; `BrowserCard.tsx`, `browser-control.ts`, `apps-browser-api.ts` | GET/POST `/api/verse/apps/browser`, GET `/doctor`, GET `/shot`; `phm browser --json`, `phm browser doctor --json` | Open tabs, latest screenshot and one button (Take screenshot). Safari only; Chrome is refused. No click or type yet. |
| Allowlisted app operations | Fleet Host Allowed apps; `AllowedAppsCard.tsx`, `apps-control-api.ts` | GET/POST `/api/verse/apps/control`; `phm apps list --json`, `phm apps request focus Cursor --json` | Previously CLI-only policy is now shared. Empty allowlist permits nothing. Per-app actions and request mode apply to every caller. |
| App action log | Fleet Host App actions; `AppActionsCard.tsx`, `apps-actions.ts`, `apps-control-api.ts` | GET `/api/verse/apps/actions`; `phm apps log --json` | Every open, focus, quit and restart on record in the feed, newest first, refusals included. Read-only; an unreadable feed reads unknown, never an empty log. |
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

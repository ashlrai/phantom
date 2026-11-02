# Console layout: one screen, three widths

The web console picks one of three layouts from the window width. The numbers
live in one place, `src/web-ui/app/console-mode.ts`
(`CONSOLE_LAYOUT_BREAKPOINTS`), and are stamped on the page as
`data-console-layout`; the stylesheets read that attribute, so every console
surface changes shape at the same widths.

| Layout | Window width | What you see |
|--------|--------------|--------------|
| compact | under 720px | The phone view. Navigation folds into a top strip, the topbar drops its keycap hint, and every panel stacks in one column. |
| regular | 720px to 1919px | The laptop view. Sidebar on the left, the panel column beside it. |
| wide | 1920px and up | The external-monitor view. The board centers and widens so panels spread across the screen instead of hugging one side. |

There is nothing to configure. Open the console on any screen and it picks
the layout:

```sh
phm serve
```

The same live state renders at every width: pool usage, burn and pace, daemon
state, and the machine's memory, swap and disk. Numbers come only from
recorded readings. A reading that is missing or stale prints `unknown`, never
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

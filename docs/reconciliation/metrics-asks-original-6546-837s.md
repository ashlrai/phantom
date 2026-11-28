# PR #6546: A3 evidence reconciliation

Original head: `cfd77b83b8e3dfbf55aabaea273f84c360e9e910`; inspected base: `aeca21bb2dc200f01c860cd1c2fbd8da5cc4d50a`.

| Original assertion | Current source evidence | Reconciliation |
| --- | --- | --- |
| Merged PRs per hour by repo | `MetricsPane` displays “Merged PRs per hour” and its by-repo series | Credited as implementation presence. |
| Merged PRs per launch by hour | `MetricsPane` displays the ratio and says human actions are not recorded and it does not measure autonomy | Credited as throughput only. |
| Shared hourly metrics series | `readMetricsSeries` in `src/core/fleet/metrics-series.ts` | Credited as implementation presence. |
| A3 is done | The original plan removes both pathless needs before checking | Rejected: neither high-leverage classification over time nor human-intervention/autonomy measurement is established by these paths. Both remain gaps. |

The original workplan's A3 slice is partially reconciled; it is not evidence that the whole PR is superseded. Other slices were not assessed. Source paths and exports establish implementation presence only, not release or live-host verification.

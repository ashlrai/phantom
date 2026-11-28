# Original #4122 parked queue preservation

Compared original `2ad3ea745771ed0d3f270fabe1933117c7c1b7be` with master `587bb0ec9e9211c1d32d8ae1b693e313cc663c15`. This is a synthetic, bounded comparison of the queue reader, not evidence of live incident recovery or permission to unpark.

| Original symbol and behavior | Current symbol and executable evidence |
| --- | --- |
| `parseDependencyGateIds`: first gate line, ordered deduplicated IDs | Same symbol; **parses gate IDs and original and newer MERGED ledger dialects** |
| `mergedJobsFromJsonl`, `readSource`: valid outcome/MERGED rows in a bounded ledger tail | Same symbols; **parses gate IDs and original and newer MERGED ledger dialects** and **uses the bounded ledger tail and orders ready jobs by lane and file order**. Current aliases are retained. |
| `readFleetQueue`, `readUnmetDeps`: unmet IDs, opt-in all-met stale parks | Same symbols; **separates unmet gates from opt-in stale parks across queue dialects** and **does not turn missing or malformed evidence into merged proof** |
| `readFleetQueue`: first three ready IDs per lane in file order, excluding parks | Same symbol; **uses the bounded ledger tail and orders ready jobs by lane and file order** |

The reader reports known IDs without MERGED evidence as unmet when the ledger is absent or malformed. A missing prompt supplies no known IDs and appears in neither detail list; neither list exposes ledger or prompt health, so an empty list is not proof of success. Existing queue health, unhinted accounting and ledger aliases remain untouched. The comparison found no missing original behavior in this slice.

Cockpit (`src/core/merge-cockpit.ts`), autopilot, API and UI portions of #4122/#5864 are outside this slice and remain with their existing owners. This matrix does not justify closing either PR.

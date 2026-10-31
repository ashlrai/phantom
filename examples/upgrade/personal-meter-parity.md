# Personal meter parity after an upgrade

From this checkout, with `tsx` available and the upgraded `phm` on `PATH`, run:

```sh
npx tsx examples/upgrade/personal-meter-parity.ts
```

The probe runs the installed `phm resources ledger --json` and `phm resources personal --json` commands. It compares the personal ledger row with the personal CLI's **weekly** percentage and reset, only when both identify the same current personal-session observation. It does not fall back to the session window. The ledger reader also reads its normal status and metrics files; the personal usage evidence comes from the personal session logs. The probe does not write usage history or inspect the CMP account. Both commands are read-only, and no provider call is made.

Output is a single bounded version 1 JSON object. `match` includes only the compared values and observation time; `mismatch` includes the same fields for diagnosis. `incomparable` means the evidence is missing, stale, lacks a reset or personal-session provenance, or comes from different instants. A fresh session may arrive between reads; rerun to obtain comparable evidence. A status-only ledger row cannot establish parity.

Exit codes: **0** verified (or help), **1** mismatch or execution failure, **2** invalid arguments, **3** insufficient or incomparable evidence. Errors are static and do not include subprocess output or paths. `--help` performs no reads. This verifies the two installed CLI projections at one observation, not every other consumer or the installation process itself.

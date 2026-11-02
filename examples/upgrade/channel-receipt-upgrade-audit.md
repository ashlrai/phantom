# Installed channel receipt upgrade audit

From a Phantom source checkout with `tsx` already available, select the absolute package root of the installed Phantom version to check. It must contain `dist/core/fleet/channel-envelope.js` and `dist/core/fleet/mason-inbox.js`. Create a new empty directory that only this probe will use, then run:

```sh
npx tsx examples/upgrade/channel-receipt-upgrade-audit.ts --phantom-dir /absolute/path/to/installed/phantom --scratch-dir /absolute/path/to/new/empty/directory
```

The probe loads those installed modules, passes the scratch directory explicitly as `runsDir`, and sends a plainly fake desktop message followed by the identical mobile message from the same fake sender to a newly constructed receiver. It reads the scratch inbox through the installed public reader. No transport or production inbox is used. It leaves receipt, inbox, and dispatch artifacts in the scratch directory; it never removes them. Use a fresh directory for every run and do not let other processes modify it during the audit. The directory itself must not be a symlink.

The versioned JSON result reports accepted and duplicate counts, whether the receipt identity matched, the inbox entry count (capped at two), whether the first source was retained, and `verified`. Errors are static JSON. `--help` prints usage without accessing the installation or scratch directory.

- **0:** verified (also returned for `--help`).
- **1:** behavioral mismatch or execution failure.
- **2:** invalid arguments or scratch directory.
- **3:** installed adapters or receipt/inbox evidence unavailable.

This checks persistence across receiver reconstruction within one process and the current dedupe window. It does not prove transport authentication, survival of a process crash between inbox append and receipt commit, or behavior of a running installation's production data.

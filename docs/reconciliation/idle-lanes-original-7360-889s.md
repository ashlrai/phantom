# Original #7360 idle-lane slice

Compared [original head 19f9f816](https://github.com/ashlrai/phantom/commit/19f9f816728028ada02cd2a761bec52ccd131986) with [master 614bdb85](https://github.com/ashlrai/phantom/commit/614bdb856f01bd19a3dac2102d874e2a3b755354). The checkout is shallow; the master commit is a boundary, so the history does not establish when or why the current implementation diverged.

| Original hunk or expectation | Preservation evidence or divergence |
| --- | --- |
| Import `laneLaunchTarget`, compare queued unheld lanes against the shed ceiling | `suppresses shed-full, shed-zero, and empty queues` and `reports actual shed room red with the effective target and exit 1 in JSON and text` invoke the command and check exits and rows. |
| Held queued lane remains warn even above shed ceiling | `reports held queued work as warn even above the shed ceiling, with exit 0` checks both formats. |
| Original rows retained configured target 8 after shed to 5 | Superseded divergence: the room and held tests assert current effective target 5 in JSON and text. |
| Original rejects malformed optional `effective_target`, accepts null as absent | Superseded divergence: `falls back to configured target for null and malformed optional readings` checks current fallback and exit 1. |
| Original refactors required count validation into `isCount` | `rejects invalid required %s with exit 2` checks each required count through the command, including unsafe integers. No validation changes are made. |
| Original adds `laneLaunchHeadroom` to the shared helper | Outside this idle-lane slice; its consumers and other original changes require separate reconciliation. The idle command uses the existing `laneLaunchTarget`. |

The injected reader supplies synthetic status and an empty ledger and records the only reads; it has no write or launch capability. These tests do not establish live host recovery or release status, and do not provide grounds to close the whole PR. Lane-starve/launchable, status API and all other original paths are outside this job.

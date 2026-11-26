# Security re-pin queue

Read the same inventory as JSON with `phm fleet repin-queue --json`.
It is a read-only repository snapshot at `8d7262ec38e55a67537e0ae3bc1940860f8bc9d2`, not
a live probe, a Security approval, or an installation receipt.

Each proposed SHA-256 is computed from the file bytes at that PR's merge
commit on master. A live SHA-256 is a recorded expectation or historical
snapshot, not a fresh measurement; `unknown` (JSON `null`) means no live digest
is established. Recheck the actual destination before adoption. Test and
documentation files are not install inputs. Superseded rows are retained
for review of the cumulative diff, not for installation.

Use the preview against a scratch bin directory while reviewing.
Only Security/ops may adopt approved changes. Before any managed install,
inspect the full plan, since the installer is not scoped to one file.
For pinned files, there is no repository install command: follow the
[ops-side re-pin boundary](MACHINERY-MIGRATION.md#boundaries).
For the staged bridge, see the [Mac pool bridge review](../contrib/mac/POOL-BRIDGE.md#requires-security-review-and-re-pin-before-contribmacinstallsh).
Record the verified live digest and adoption receipt before removing an
entry from both this page and the JSON inventory.

## [#9120](https://github.com/ashlrai/phantom/pull/9120): Leader worktree audit and reapers

Merge: `5349733840c1860104cc95044753f5f68683b1a3`

- Preview: `python3 fleet/sync.py --json`.
- Install after approval: no supported repository command for this entry.

Ops-only adoption after Security reviews the full caller pin chain; fleet sync reports pinned drift but never writes. Verify the deployed CLI supplies the classifier from #9087. Keep the deep helper and nobase references unchanged.

| File | Reviewed SHA-256 | Live SHA-256 | Action | Live pin evidence |
|---|---|---|---|---|
| `contrib/mac/archive-reap.sh` | `642666b575482fd3bb37b7200e6274525230512bddf0ba89a7a79029d823a4f5` | `af513d5e0cf805bf132de7a3dcc7cdabf5c0c1bee42406e60a01becd14696c0e` | ops-repin | Supplied leader snapshot. |
| `contrib/mac/git-safe-env.sh` | `01e1e5ab72016a5b6fbd96c76cb903eb7c61849084b20ae04374219dcd077331` | `01e1e5ab72016a5b6fbd96c76cb903eb7c61849084b20ae04374219dcd077331` | unchanged-reference | Supplied leader snapshot. |
| `contrib/mac/nobase-synth.sh` | `9a83dcfe3c922e667698b6e9c246984645af3ea77e80ab4531a3eac0120d6557` | `9a83dcfe3c922e667698b6e9c246984645af3ea77e80ab4531a3eac0120d6557` | unchanged-reference | Supplied leader snapshot. |
| `contrib/mac/reap-merged.sh` | `982483189de0d54516fbcc052c4f712fa9bf4e9721331457a250af6444e5d66d` | `36fc5897704663b9161e9e2dbcf98b95f9ab002cfaed10979661970c88131973` | ops-repin | Supplied leader snapshot. |
| `contrib/mac/reap-one.sh` | `e45b88f98144e87693b27ca8b0b4d72a071e886e407cfda9541a810384087c0c` | `97e380e2702d393105b490fa4e9bc18c78703acd73e72229198554575747c7e9` | ops-repin | Supplied leader snapshot. |
| `contrib/mac/reaper-plan.py` | `95c1c9111db21cf4ca13ba2e8eb6dd2a04a651017ca127505a0cdc91e1a687b0` | `unknown` | ops-repin | New adapter in the PR; no deployed baseline was supplied. |
| `contrib/mac/selfrun.sh` | `efe1df5e953d2738fc98ea3c1563b05eb68d72c7e9559d8ce371b98ad4270542` | `3754e7929262dd499873960732a73d888c5eaaff6c0f755232a75c653ca7309f` | ops-repin | Supplied leader snapshot. |
| `fleet/manifest.json` | `f48050ff4a6c3b61800fc29ba99d02bf6ee5b44aa45663e0a6a794101e8af0b5` | `unknown` | repo-only | — |

## [#9132](https://github.com/ashlrai/phantom/pull/9132): Guarded pool reservation bridge

Merge: `3d18da57f16e4b588cad541c6604be4d4f6490ee`

- Preview: `contrib/mac/install.sh --dry-run --json`.
- Install after approval: no supported repository command for this entry.

The emitter and reservation entry point have no repo installer. Use the #9152 reservation successor. Validate Seatbelt containment, cancellation, and provider evidence on macOS before adoption. The installer only previews the historical launcher by default; do not supply its digest to replace the guarded live launcher.

| File | Reviewed SHA-256 | Live SHA-256 | Action | Live pin evidence |
|---|---|---|---|---|
| `contrib/mac/host-integration/agy-pace.py` | `f365f34b1e578e726f18f8e1f4b2f4a755127b31c72d34b73232f1ddd0dca891` | `f365f34b1e578e726f18f8e1f4b2f4a755127b31c72d34b73232f1ddd0dca891` | unchanged-reference | Leader snapshot recorded by #9132; not an installer input. |
| `contrib/mac/host-integration/agy.sb` | `fd4847666f127ec5e64eca79ff40d41915e91f036ff3b8a82f1b06b257ca72d0` | `fd4847666f127ec5e64eca79ff40d41915e91f036ff3b8a82f1b06b257ca72d0` | unchanged-reference | Leader snapshot recorded by #9132; not an installer input. |
| `contrib/mac/host-integration/devin_flash_lane.py` | `f36d9e5b5d30696f82a145927abb1bc9a356290d9baf43081691d4a1f538f4d4` | `f36d9e5b5d30696f82a145927abb1bc9a356290d9baf43081691d4a1f538f4d4` | unchanged-reference | Leader snapshot recorded by #9132; not an installer input. |
| `contrib/mac/host-integration/lane_rules.py` | `f1429cee714c9e03da9d8c449f731480ec5e3aeb20faead44b087dd8d6488eef` | `f1429cee714c9e03da9d8c449f731480ec5e3aeb20faead44b087dd8d6488eef` | unchanged-reference | Leader snapshot recorded by #9132; not an installer input. |
| `contrib/mac/host-integration/launch.sh` | `f863cb1c9b3938ad4e9ddf242fbf90142fb7e1dbab5b49d81addcb2186b73126` | `f863cb1c9b3938ad4e9ddf242fbf90142fb7e1dbab5b49d81addcb2186b73126` | unchanged-reference | Leader snapshot recorded by #9132; not an installer input. |
| `contrib/mac/host-integration/launcher-snapshot.json` | `d9474205f598adcac1a30fabdfc557a01c982346dde56d7cb919afea452c353a` | `unknown` | repo-only | — |
| `contrib/mac/host-integration/zai-pace.py` | `e35cb8df93a93c1903c0702fc7566126034e1a3d99f97afa18ea7e36a7c24bcc` | `e35cb8df93a93c1903c0702fc7566126034e1a3d99f97afa18ea7e36a7c24bcc` | unchanged-reference | Leader snapshot recorded by #9132; not an installer input. |
| `contrib/mac/host-integration/zai.sb` | `84ece944dcc9d325d67b91883d05c998a2d2371518338b0b03ea534c4e6b8f70` | `84ece944dcc9d325d67b91883d05c998a2d2371518338b0b03ea534c4e6b8f70` | unchanged-reference | Leader snapshot recorded by #9132; not an installer input. |
| `contrib/mac/install.sh` | `3da19669e71820d0d910d330e33cdbfe6587a519bb6cab215f910f87f1d8c62b` | `unknown` | repo-only | — |
| `contrib/mac/pool_bridge_evidence.py` | `c1206633972b52311b87598dae1c2126527a384c7bb6da91f017362f2aaf50d0` | `unknown` | held | — |
| `contrib/mac/pool_bridge_reservation.py` | `95bc91fde3b748cd87586c3e72358261c8de1956caad32d7334cdcc3731fbfe8` | `unknown` | superseded | — |

## [#9152](https://github.com/ashlrai/phantom/pull/9152): Guarded Flash reservations and offline bridge verifier

Merge: `8d7262ec38e55a67537e0ae3bc1940860f8bc9d2`

- Preview: `/bin/bash contrib/mac/host-integration/verify-pool-bridge.sh`.
- Install after approval: no supported repository command for this entry.

Supersedes the #9132 reservation entry point. Run the offline verifier on the Mac and have Security and ops review the derived profile, pins, and settlement before adoption; Linux fixtures do not verify Seatbelt.

| File | Reviewed SHA-256 | Live SHA-256 | Action | Live pin evidence |
|---|---|---|---|---|
| `contrib/mac/host-integration/agent.sb` | `975545e57a00070ec72d5308cb33f9e611636b570a0977b2316bfb9c33bf641d` | `975545e57a00070ec72d5308cb33f9e611636b570a0977b2316bfb9c33bf641d` | unchanged-reference | Leader snapshot recorded by #9152; not an installer input. |
| `contrib/mac/host-integration/devin-overage-stop.py` | `9d92f38c2107522285f40b7ff18553c043d40e9b3dcf717db7dccd2f5fc56a60` | `9d92f38c2107522285f40b7ff18553c043d40e9b3dcf717db7dccd2f5fc56a60` | unchanged-reference | Leader snapshot recorded by #9152; not an installer input. |
| `contrib/mac/host-integration/launcher-snapshot.json` | `dcb3cf76986b361fe1eae308ec1c757e5253c593406d3e2f10f651ae90e7e5a6` | `unknown` | repo-only | — |
| `contrib/mac/host-integration/verify-pool-bridge.sh` | `34bdb7e7a60b274b3511bc9be01842cc6e41494627bb2472a6c27484dd6f6430` | `unknown` | repo-only | — |
| `contrib/mac/pool_bridge_reservation.py` | `1bcbe3ded1d89d13ac22ee448d263462f3d58fcceff65ff0bad6e6f84238f894` | `unknown` | held | — |

## [#9078](https://github.com/ashlrai/phantom/pull/9078): Guarded pool evidence emitter

Merge: `51b30cd70f325bea03858a2d4c49558cb08d51d4`

- Preview: not applicable.
- Install after approval: no supported repository command for this entry.

No pinned files changed. Review and adopt the successor in #9132 instead of deploying this revision.

| File | Reviewed SHA-256 | Live SHA-256 | Action | Live pin evidence |
|---|---|---|---|---|
| `contrib/mac/pool_bridge_evidence.py` | `a967c9d0b86fa1af1410d0519e38b48354cdd2b12f5ddb0c5cc6a90353e4bbf4` | `unknown` | superseded | — |

## [#9091](https://github.com/ashlrai/phantom/pull/9091): Restock from signed repository scope

Merge: `4f8339418c2a9f4836e8587026b24f6ca538961c`

- Preview: `contrib/mac/install.sh --dry-run --json`.
- Install after approval: no supported repository command for this entry.

Merged; use the #9149 successor for rollout, not this earlier restocker. Coordinate the restocker with the selfrun.sh pin so the next tick does not reject it.

| File | Reviewed SHA-256 | Live SHA-256 | Action | Live pin evidence |
|---|---|---|---|---|
| `contrib/mac/restock.py` | `614206cac55f716790bbd46c0a5dd11780251553f8545d98c4d24d88d8c900dd` | `56ca079df87af6096dfa3a3e94a62e59fb63bb4726f20b3ddb6b963d480f9bc1` | superseded | Expected by the supplied leader selfrun.sh pin; verify live. |

## [#9149](https://github.com/ashlrai/phantom/pull/9149): Preserve repository-scoped PR holds in restock

Merge: `239f194549ba7426c9275a41c25df7fdb8e0f0ef`

- Preview: `contrib/mac/install.sh --dry-run --json`.
- Install after approval: `contrib/mac/install.sh --json`.

Roll out with #9120 only after Security updates the digest expected by the approved selfrun.sh and verifies the other managed inputs in the installer plan.

| File | Reviewed SHA-256 | Live SHA-256 | Action | Live pin evidence |
|---|---|---|---|---|
| `contrib/mac/restock.py` | `e595cb71af095f55ecf5649d51b51017f088620f302e3ab1af6aa43822e2ed60` | `56ca079df87af6096dfa3a3e94a62e59fb63bb4726f20b3ddb6b963d480f9bc1` | managed-install | Expected by the supplied leader selfrun.sh pin; verify live. |

## [#9075](https://github.com/ashlrai/phantom/pull/9075): Refresh batch and launcher model catalog

Merge: `e715059d7b27e416a194525c7b1a117e49e17c7c`

- Preview: `contrib/mac/install.sh --dry-run --json`.
- Install after approval: `contrib/mac/install.sh --json`.

The command only covers the reviewed managed batch files. The historical launcher candidate is held; reconcile it with live Flash and paid-overage guards and review the resulting digest separately.

| File | Reviewed SHA-256 | Live SHA-256 | Action | Live pin evidence |
|---|---|---|---|---|
| `contrib/mac/batch-sessions.json` | `1c05c88e917286e29f4d20f42ee42ec8cb172f51aacfa920848f9b724aeab061` | `unknown` | managed-install | — |
| `contrib/mac/batch_sessions.py` | `5d9f7e3f1af3e50b68864ae262ea08829ab1d9288198d37548473ede2855ec65` | `unknown` | managed-install | — |
| `contrib/mac/host-integration/launch.candidate.sh` | `b125116078db143317fc9807805619a886cee62403ffd6a2b3999545207e6e08` | `f863cb1c9b3938ad4e9ddf242fbf90142fb7e1dbab5b49d81addcb2186b73126` | held | Live launch.sh reference from #9132, not the historical candidate. |

## [#9072](https://github.com/ashlrai/phantom/pull/9072): Capacity planner dispatch integration

Merge: `6643eb529548f0431d5a26fd0be571d78c5161ea`

- Preview: `contrib/mac/install.sh --dry-run --json`.
- Install after approval: `contrib/mac/install.sh --json`.

Review dispatcher and work-market changes together; an install applies the entire approved managed plan.

| File | Reviewed SHA-256 | Live SHA-256 | Action | Live pin evidence |
|---|---|---|---|---|
| `contrib/mac/dispatchd.py` | `728ada3ce28a6ea876648ba67c6c26764074808e251cf70d73d7dec36837d2e2` | `unknown` | managed-install | — |
| `contrib/mac/work_market.py` | `1db7d19188f0d19b1da15f22b3198e54ccfe8e48eb94e338e44d07e7e33f1322` | `unknown` | managed-install | — |

## [#9054](https://github.com/ashlrai/phantom/pull/9054): Repository value and dispatch ranking

Merge: `a34c14c9e8e94c25ae7ac397909c522ed5cee21a`

- Preview: `contrib/mac/install.sh --dry-run --json`.
- Install after approval: no supported repository command for this entry.

Dispatch and work-market revisions are superseded by #9072; restock is superseded by #9149. Review the cumulative diff, not these older blobs.

| File | Reviewed SHA-256 | Live SHA-256 | Action | Live pin evidence |
|---|---|---|---|---|
| `contrib/mac/dispatchd.py` | `4edad79c8af5bf0f97dc1378d115a0c0de8cd8c1f39fa2cd07d71945323cca4b` | `unknown` | superseded | — |
| `contrib/mac/restock.py` | `87c27d9a8fca3b27624ca1eb803315e9ec912a9565a49b54cbae05598366b373` | `56ca079df87af6096dfa3a3e94a62e59fb63bb4726f20b3ddb6b963d480f9bc1` | superseded | Expected by the supplied leader selfrun.sh pin; verify live. |
| `contrib/mac/work_market.py` | `4a3f2925141cdc191d1aa5c7646da85b2f02543cbd298b2e4cfac8fc1b6962d8` | `unknown` | superseded | — |

## [#9048](https://github.com/ashlrai/phantom/pull/9048): Expiring-allowance routing

Merge: `8bad169e75984d3b9fd2c32a9ab0e9a371f4e269`

- Preview: `contrib/mac/install.sh --dry-run --json`.
- Install after approval: no supported repository command for this entry.

Superseded by #9054 and #9072; review the cumulative dispatch and work-market diff.

| File | Reviewed SHA-256 | Live SHA-256 | Action | Live pin evidence |
|---|---|---|---|---|
| `contrib/mac/dispatchd.py` | `19adb3ddca651dfaf8dd1f94b558b77bc345c1ea8a42e12aa475e1c918d68cfa` | `unknown` | superseded | — |
| `contrib/mac/work_market.py` | `4b920a67736079d61c32f7aea266c61ea3a9abcb92bb26fc8b1f1843d5092f22` | `unknown` | superseded | — |

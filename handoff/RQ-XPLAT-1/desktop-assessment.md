# Desktop port assessment

Source baseline: `06ff9648d4`. This is source inspection, not native build or installation acceptance.

| Area | Current source evidence | Next step |
| --- | --- | --- |
| Shared shell | Tauri v2, loopback Verse UI, bundled CLI sidecar, tray and notification plugins provide a portable base (`desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml`). | Keep the CLI/browser-console path available independently of desktop packages. |
| Linux | `desktop/src-tauri/build.rs` refuses Linux source builds because the resolved GTK3/glib chain is quarantined. `tauri.linux.conf.json` disables bundling and `assert-desktop-bundle-policy.mjs` independently refuses it. | Keep all guards. A supported dependency migration and independent security review must precede native Linux acceptance. No Linux desktop shipping claim is supported here. |
| Windows | Sidecar preparation knows Windows target triples and `.exe` names. Tauri config has Windows packaging settings. Desktop README describes draft-only Windows outputs. | Qualify fresh install, sidecar launch and shutdown, loopback authentication, update rollback, tray, notifications and file selection on a Windows host. Cross-compilation is not acceptance. |
| Native browser and computer use | `browser_input.rs`, `browser_pane.rs` and the macOS Cargo dependency section rely on AppKit/WebKit and native event APIs. | Add explicit platform capability reporting, then implement separate Windows and Linux adapters. Disabled capabilities must remain truthful and preserve input and media boundaries. |
| Fleet custody and resident lifecycle | `fleet_ops.rs` invokes macOS authorization through `osascript`; `native_launchd_broker.rs` and `native_update_runtime.rs` contain macOS implementations with other-platform branches. | Extend reviewed platform interfaces separately. Generic service registration cannot substitute for native custody authorization. |
| Local packaging | `desktop/scripts/build-local.mjs` is tied to the existing macOS signing identity. Release/updater policy is enforced separately. | Leave signing and notarization untouched. The signer owner can supply a platform verifier through the installer's fixed-argument hook after byte-integrity checks and before installation. |

Recommended order: qualify the portable CLI, service manager and sensors first; qualify the Windows shell next; unblock Linux desktop through the existing dependency and security acceptance process. This job does not modify signing, notarization, desktop quarantine, live services or release policy.

Native CLI assets currently install only one executable, while `scripts/build-sea.mjs` expects adjacent `public/` and worker files. The installers therefore default to the complete verified npm package. `PHANTOM_PREFER_NATIVE=1` explicitly selects the existing CLI-only native path. Asset bundling remains with the existing release-assets work.

# Desktop updater findings

- Installed CFBundleShortVersionString read from /Applications/Phantom.app/Contents/Info.plist: 3.30.32.
- Read-only source CLI app update status confirms current 3.30.32, available null, zero execution leases and zero unknown leases.
- Source CLI fleet update-why reaches the public feed and reports 3.30.33 available. The earlier 403 applies to GitHub API metadata, not that feed.
- Existing verifyCompatibleUpdateManifest with the commissioned canonical-v2 public trust verifies the 3.30.33 feed envelope; discovery version, app URL and signature match the signed manifest. No app artifact was fetched or installed.
- Native runtime checks at startup, every 15 minutes and after polling gaps over 30 seconds. Disabled updates remain disabled; concurrent checks coalesce.
- Native updates verify a signed paired manifest, discovery metadata and app bytes before staging. Host admission and normal Quit control application.
- scripts/publish-desktop-release.mjs already downloads and verifies latest.json after publication, then independently verifies published artifacts.
- Feed requests currently have no cache revalidation directive. Discovery parsing lives in the native binary rather than the required library test lane.
- The prior status model conflated staged, waiting-for-idle and waiting-for-app-quit and claimed automatic restarts. Status copy now identifies admission, idle and Quit separately and compares the running native desktop version before requesting reopen.
- Source-only work cannot prove installed version advancement after a future publish. Do not claim that acceptance result without installed-bundle evidence.
- toolsUsed: [] (no companion tools called).
